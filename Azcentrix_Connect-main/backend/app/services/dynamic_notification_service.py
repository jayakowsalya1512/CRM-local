"""Dynamic notification engine shared across modules."""

from __future__ import annotations

import logging
import re
from datetime import date, datetime
from app.core.timezone import now_ist, today_ist
from decimal import Decimal
from html import escape
from typing import Any, Optional
from urllib.parse import urljoin

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database import MasterSessionLocal, TenantBase, get_tenant_session_by_db_name
from app.models.all_models import (
    Approval,
    Customer,
    CustomerContact,
    EMDBG,
    Lead,
    NotificationDeliveryLog,
    NotificationEventDefinition,
    NotificationRule,
    NotificationTemplate,
    SalesCustomerAssignment,
    Tender,
    User,
    WorkOrder,
)
from app.models.tenant import Tenant
from app.services.notification_service import (
    get_bool_setting,
    get_setting_value,
    is_email_enabled_for_category,
    send_email_to_user,
    upsert_notification,
)
from app.services.tenant_email_service import (
    TenantEmailConfigurationError,
    TenantEmailDeliveryError,
    send_tenant_email,
)

logger = logging.getLogger(__name__)

INTERNAL_RECIPIENT_RESOLVER_KEYS = (
    "assignee",
    "creator",
    "requester",
    "approver",
    "manager",
)
ROLE_RECIPIENT_RESOLVER_KEYS = (
    "role:admin",
    "role:ceo",
    "role:accounts",
)
CUSTOMER_RECIPIENT_RESOLVER_KEYS = (
    "customer_owner",
    "customer_primary_contact",
    "customer_all_contacts",
)
SUPPORTED_RECIPIENT_RESOLVER_KEYS = (
    *INTERNAL_RECIPIENT_RESOLVER_KEYS,
    *ROLE_RECIPIENT_RESOLVER_KEYS,
    *CUSTOMER_RECIPIENT_RESOLVER_KEYS,
)
SUPPORTED_RECIPIENT_TYPES = SUPPORTED_RECIPIENT_RESOLVER_KEYS
CHANNEL_BOTH = "both"
CHANNEL_IN_APP = "in_app"
CHANNEL_EMAIL = "email"
TEMPLATE_CHANNELS = (CHANNEL_IN_APP, CHANNEL_EMAIL)
MODULE_KEY_ALIASES = {
    "customer": "customers",
    "work_order": "workorders",
    "work_orders": "workorders",
}
ROLE_ALIASES: dict[str, tuple[str, ...]] = {
    "admin": ("admin",),
    "ceo": ("ceo",),
    "manager": ("manager", "vp"),
    "accounts": ("accounts",),
    "sales": ("sales",),
    "support": ("support",),
}
MODULE_LABELS = {
    "leads": "Leads",
    "tenders": "Tenders",
    "workorders": "Work Orders",
    "emdbg": "EMD/BG",
    "customers": "Customers",
}
MODULE_ENTITY_LABELS = {
    "leads": "Lead",
    "tenders": "Tender",
    "workorders": "Work Order",
    "emdbg": "EMD/BG",
    "customers": "Customer",
}
MODULE_ROUTES = {
    "leads": "/leads",
    "tenders": "/tenders",
    "workorders": "/workorders",
    "emdbg": "/emdbg",
    "customers": "/customers",
}
MODULE_EMAIL_DETAIL_FIELDS: dict[str, tuple[tuple[str, str], ...]] = {
    "leads": (
        ("Lead Ref", "lead_ref_id"),
        ("Status", "status"),
        ("Priority", "priority"),
        ("Assigned To", "assignee_name"),
    ),
    "tenders": (
        ("Tender No", "tender_num"),
        ("Customer", "customer_name"),
        ("Status", "tender_status"),
        ("Assigned To", "assignee_name"),
    ),
    "workorders": (
        ("Project", "project_title"),
        ("Customer", "customer_name"),
        ("Status", "status"),
        ("Progress", "progress_percent"),
        ("PO Number", "po_number"),
        ("Assigned To", "assignee_name"),
    ),
    "emdbg": (
        ("Instrument Type", "instrument_type"),
        ("Amount", "amount"),
        ("Status", "status"),
        ("Expiry Date", "expiry_date"),
    ),
    "customers": (
        ("Status", "account_status"),
        ("Potential", "account_potential"),
        ("Potential Value", "potential_value"),
        ("Approval Status", "approval_status"),
        ("Owner", "customer_owner_name"),
    ),
}
FIELD_LABEL_OVERRIDES = {
    "lead_ref_id": "Lead Ref",
    "tender_num": "Tender No",
    "wo_number": "Work Order No",
    "po_number": "PO Number",
    "project_title": "Project",
    "reference_num": "Reference",
    "instrument_type": "Instrument Type",
    "progress_percent": "Progress",
    "account_status": "Status",
    "account_potential": "Potential",
    "potential_value": "Potential Value",
    "approval_status": "Approval Status",
    "customer_owner_name": "Owner",
}
AMOUNT_FIELD_KEYS = {
    "amount",
    "bid_amount",
    "po_value",
    "wo_value",
    "potential_value",
}
USER_REFERENCE_FIELD_KEYS = {
    "assigned_to",
    "created_by",
    "updated_by",
    "requested_by",
    "requested_to",
    "approved_by",
    "project_manager_id",
    "creator_user_id",
    "assignee_user_id",
    "requester_user_id",
    "approver_user_id",
    "customer_owner_user_id",
}
MODULE_RECORD_MODELS = {
    "leads": Lead,
    "tenders": Tender,
    "workorders": WorkOrder,
    "emdbg": EMDBG,
    "customers": Customer,
}
MODULE_RECORD_CONFIG: dict[str, dict[str, Any]] = {
    "leads": {
        "assignee_fields": ("assigned_to",),
        "creator_fields": ("created_by",),
        "email_fields": ("email",),
        "record_ref_fields": ("lead_ref_id", "lead_title"),
    },
    "tenders": {
        "assignee_fields": ("assigned_to",),
        "creator_fields": ("created_by",),
        "email_fields": (),
        "record_ref_fields": ("tender_num", "portal_ref_number", "tender_title"),
    },
    "workorders": {
        "assignee_fields": ("project_manager_id",),
        "creator_fields": ("created_by",),
        "email_fields": (),
        "record_ref_fields": ("wo_number", "project_title"),
    },
    "emdbg": {
        "assignee_fields": (),
        "creator_fields": ("created_by",),
        "email_fields": (),
        "record_ref_fields": ("reference_num", "instrument_number"),
    },
    "customers": {
        "assignee_fields": ("assigned_to",),
        "creator_fields": ("created_by",),
        "email_fields": (),
        "record_ref_fields": ("customer_name",),
    },
}
LEGACY_LEAD_RULE_SETTING_KEYS: dict[tuple[str, str], str] = {
    ("new_lead", "assignee"): "lead_notify_new_lead_assigned_user",
    ("new_lead", "manager"): "lead_notify_new_lead_manager",
    ("new_lead", "role:admin"): "lead_notify_new_lead_admin",
    ("new_lead", "role:ceo"): "lead_notify_new_lead_ceo",
    ("lead_assignment", "assignee"): "lead_notify_lead_assignment_assigned_user",
    ("lead_assignment", "manager"): "lead_notify_lead_assignment_manager",
    ("lead_assignment", "role:admin"): "lead_notify_lead_assignment_admin",
    ("lead_assignment", "role:ceo"): "lead_notify_lead_assignment_ceo",
    ("status_qualified", "assignee"): "lead_notify_status_qualified_assigned_user",
    ("status_qualified", "manager"): "lead_notify_status_qualified_manager",
    ("status_qualified", "role:admin"): "lead_notify_status_qualified_admin",
    ("status_qualified", "role:ceo"): "lead_notify_status_qualified_ceo",
    ("status_won", "assignee"): "lead_notify_status_won_assigned_user",
    ("status_won", "manager"): "lead_notify_status_won_manager",
    ("status_won", "role:admin"): "lead_notify_status_won_admin",
    ("status_won", "role:ceo"): "lead_notify_status_won_ceo",
    ("status_lost", "assignee"): "lead_notify_status_lost_assigned_user",
    ("status_lost", "manager"): "lead_notify_status_lost_manager",
    ("status_lost", "role:admin"): "lead_notify_status_lost_admin",
    ("status_lost", "role:ceo"): "lead_notify_status_lost_ceo",
    ("high_priority_lead", "assignee"): "lead_notify_high_priority_lead_assigned_user",
    ("high_priority_lead", "manager"): "lead_notify_high_priority_lead_manager",
    ("high_priority_lead", "role:admin"): "lead_notify_high_priority_lead_admin",
    ("high_priority_lead", "role:ceo"): "lead_notify_high_priority_lead_ceo",
}
PLACEHOLDER_RE = re.compile(r"{{\s*([a-zA-Z0-9_]+)\s*}}")


def normalize_notification_module_key(module_key: str) -> str:
    return MODULE_KEY_ALIASES.get(str(module_key or "").strip().lower(), str(module_key or "").strip().lower())


def _dedupe_strs(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def get_supported_recipient_resolver_keys(module_key: Optional[str] = None) -> list[str]:
    normalized_module_key = normalize_notification_module_key(module_key or "")
    if not normalized_module_key:
        return list(SUPPORTED_RECIPIENT_RESOLVER_KEYS)

    keys: list[str] = ["creator", "manager", "role:admin", "role:ceo"]
    if normalized_module_key in {"leads", "tenders", "workorders"}:
        keys.append("assignee")
    if normalized_module_key in {"tenders", "emdbg", "customers"}:
        keys.extend(["requester", "approver"])
    if normalized_module_key == "emdbg":
        keys.append("role:accounts")
    if normalized_module_key in {"leads", "tenders", "workorders", "emdbg", "customers"}:
        keys.extend(["customer_owner", "customer_primary_contact", "customer_all_contacts"])
    return _dedupe_strs(keys)


def get_default_linked_resolvers(module_key: str, event_key: str) -> list[str]:
    normalized_module_key = normalize_notification_module_key(module_key)
    normalized_event_key = str(event_key or "").strip().lower()

    if normalized_module_key == "leads":
        return ["assignee"]
    if normalized_module_key == "tenders":
        if normalized_event_key.endswith("approval_requested"):
            return ["approver"]
        return ["assignee"]
    if normalized_module_key == "workorders":
        return ["assignee"]
    if normalized_module_key == "emdbg":
        return ["requester", "approver"]
    if normalized_module_key == "customers":
        if normalized_event_key.endswith("approval_requested"):
            return ["approver"]
        return ["customer_owner"]
    return []


def map_ui_to_resolver_keys(module_key: str, event_key: str, ui_flags: dict[str, Any]) -> list[str]:
    recipients: list[str] = []
    if bool(ui_flags.get("linked_users")):
        recipients.extend(get_default_linked_resolvers(module_key, event_key))
    if bool(ui_flags.get("manager")):
        recipients.append("manager")
    if bool(ui_flags.get("admin")):
        recipients.append("role:admin")
    if bool(ui_flags.get("ceo")):
        recipients.append("role:ceo")
    return _dedupe_strs(recipients)


def _rule(
    recipient_type: str,
    *,
    recipient_role: Optional[str] = None,
    recipient_user_id: Optional[int] = None,
    record_field_name: Optional[str] = None,
    channel: str = CHANNEL_BOTH,
    is_active: bool = True,
    sort_order: int = 0,
) -> dict[str, Any]:
    return {
        "recipient_type": recipient_type,
        "recipient_role": recipient_role,
        "recipient_user_id": recipient_user_id,
        "record_field_name": record_field_name,
        "channel": channel,
        "is_active": is_active,
        "sort_order": sort_order,
    }


def _templates(
    subject: str,
    body: str,
    *,
    action_url_template: Optional[str],
    html_template: Optional[str] = None,
) -> dict[str, dict[str, Any]]:
    return {
        CHANNEL_IN_APP: {
            "subject_template": subject,
            "body_template": body,
            "action_url_template": action_url_template,
            "is_active": True,
        },
        CHANNEL_EMAIL: {
            "subject_template": subject,
            "body_template": body,
            "html_template": html_template,
            "action_url_template": action_url_template,
            "is_active": True,
        },
    }


DEFAULT_EVENT_CATALOG: list[dict[str, Any]] = [
    {
        "module_key": "leads",
        "event_key": "new_lead",
        "label": "Lead Created",
        "category": "event",
        "description": "Fires when a lead is created.",
        "default_action": "lead_new",
        "rules": [
            _rule("assignee", is_active=False, sort_order=10),
            _rule("manager", is_active=False, sort_order=20),
            _rule("role", recipient_role="admin", is_active=False, sort_order=30),
            _rule("role", recipient_role="ceo", is_active=False, sort_order=40),
        ],
        "templates": _templates(
            "Lead Created: {{lead_title}}",
            "{{actor_name}} created lead {{lead_title}}. Assigned to {{assignee_name}}.",
            action_url_template="/leads",
        ),
    },
    {
        "module_key": "leads",
        "event_key": "lead_assignment",
        "label": "Lead Assigned",
        "category": "event",
        "description": "Fires when a lead is assigned.",
        "default_action": "lead_assign",
        "rules": [
            _rule("assignee", sort_order=10),
            _rule("manager", is_active=False, sort_order=20),
            _rule("role", recipient_role="admin", is_active=False, sort_order=30),
            _rule("role", recipient_role="ceo", is_active=False, sort_order=40),
        ],
        "templates": _templates(
            "Lead Assigned: {{lead_title}}",
            "{{lead_title}} was assigned to {{assignee_name}} by {{actor_name}}.",
            action_url_template="/leads",
        ),
    },
    {
        "module_key": "leads",
        "event_key": "status_qualified",
        "label": "Lead Qualified",
        "category": "event",
        "description": "Fires when a lead becomes Opportunity Created.",
        "default_action": "lead_qualified",
        "rules": [
            _rule("assignee", sort_order=10),
            _rule("manager", sort_order=20),
            _rule("role", recipient_role="admin", is_active=False, sort_order=30),
            _rule("role", recipient_role="ceo", is_active=False, sort_order=40),
        ],
        "templates": _templates(
            "Lead Qualified: {{lead_title}}",
            "{{lead_title}} moved to Opportunity Created by {{actor_name}}.",
            action_url_template="/leads",
        ),
    },
    {
        "module_key": "leads",
        "event_key": "status_won",
        "label": "Lead Won",
        "category": "event",
        "description": "Fires when a lead is converted to a tender.",
        "default_action": "lead_won",
        "rules": [
            _rule("assignee", sort_order=10),
            _rule("manager", sort_order=20),
            _rule("role", recipient_role="admin", sort_order=30),
            _rule("role", recipient_role="ceo", sort_order=40),
        ],
        "templates": _templates(
            "Lead Won: {{lead_title}}",
            "{{lead_title}} was converted to tender {{tender_num}} by {{actor_name}}.",
            action_url_template="/leads",
        ),
    },
    {
        "module_key": "leads",
        "event_key": "status_lost",
        "label": "Lead Lost",
        "category": "event",
        "description": "Fires when a lead is marked lost.",
        "default_action": "lead_lost",
        "rules": [
            _rule("assignee", sort_order=10),
            _rule("manager", sort_order=20),
            _rule("role", recipient_role="admin", sort_order=30),
            _rule("role", recipient_role="ceo", sort_order=40),
        ],
        "templates": _templates(
            "Lead Lost: {{lead_title}}",
            "{{lead_title}} was marked lost by {{actor_name}}.",
            action_url_template="/leads",
        ),
    },
    {
        "module_key": "leads",
        "event_key": "high_priority_lead",
        "label": "High Priority Lead",
        "category": "event",
        "description": "Fires when a lead is high priority.",
        "default_action": "lead_high",
        "rules": [
            _rule("assignee", sort_order=10),
            _rule("manager", sort_order=20),
            _rule("role", recipient_role="admin", sort_order=30),
            _rule("role", recipient_role="ceo", sort_order=40),
        ],
        "templates": _templates(
            "High Priority Lead: {{lead_title}}",
            "{{lead_title}} is marked as high priority.",
            action_url_template="/leads",
        ),
    },
    {
        "module_key": "tenders",
        "event_key": "step2_approval_requested",
        "label": "Tender Step 2 Approval Requested",
        "category": "approval",
        "description": "Fires when tender step 2 is sent for approval.",
        "default_action": "tender_step2_approval_requested",
        "rules": [_rule("approver", sort_order=10)],
        "templates": _templates(
            "Tender Step 2 Approval Needed: {{tender_title}}",
            "{{actor_name}} requested Step 2 approval for tender {{tender_title}}.",
            action_url_template="/tenders",
        ),
    },
    {
        "module_key": "tenders",
        "event_key": "step2_approved",
        "label": "Tender Step 2 Approved",
        "category": "approval",
        "description": "Fires when tender step 2 is approved.",
        "default_action": "tender_step2_approved",
        "rules": [_rule("assignee", sort_order=10)],
        "templates": _templates(
            "Tender Step 2 Approved: {{tender_title}}",
            "Tender {{tender_title}} Step 2 was approved by {{actor_name}}.",
            action_url_template="/tenders",
        ),
    },
    {
        "module_key": "tenders",
        "event_key": "step2_rejected",
        "label": "Tender Step 2 Rejected",
        "category": "approval",
        "description": "Fires when tender step 2 is rejected.",
        "default_action": "tender_step2_rejected",
        "rules": [_rule("assignee", sort_order=10)],
        "templates": _templates(
            "Tender Step 2 Rejected: {{tender_title}}",
            "Tender {{tender_title}} Step 2 was rejected by {{actor_name}}. {{reason}}",
            action_url_template="/tenders",
        ),
    },
    {
        "module_key": "tenders",
        "event_key": "step3_approval_requested",
        "label": "Tender Step 3 Approval Requested",
        "category": "approval",
        "description": "Fires when tender step 3 is sent for approval.",
        "default_action": "tender_step3_approval_requested",
        "rules": [_rule("approver", sort_order=10)],
        "templates": _templates(
            "Tender Step 3 Approval Needed: {{tender_title}}",
            "{{actor_name}} requested Step 3 approval for tender {{tender_title}}.",
            action_url_template="/tenders",
        ),
    },
    {
        "module_key": "tenders",
        "event_key": "step3_approved",
        "label": "Tender Step 3 Approved",
        "category": "approval",
        "description": "Fires when tender step 3 is approved.",
        "default_action": "tender_step3_approved",
        "rules": [_rule("assignee", sort_order=10)],
        "templates": _templates(
            "Tender Step 3 Approved: {{tender_title}}",
            "Tender {{tender_title}} Step 3 was approved by {{actor_name}}.",
            action_url_template="/tenders",
        ),
    },
    {
        "module_key": "tenders",
        "event_key": "step3_rejected",
        "label": "Tender Step 3 Rejected",
        "category": "approval",
        "description": "Fires when tender step 3 is rejected.",
        "default_action": "tender_step3_rejected",
        "rules": [_rule("assignee", sort_order=10)],
        "templates": _templates(
            "Tender Step 3 Rejected: {{tender_title}}",
            "Tender {{tender_title}} Step 3 was rejected by {{actor_name}}. {{reason}}",
            action_url_template="/tenders",
        ),
    },
    {
        "module_key": "tenders",
        "event_key": "submitted",
        "label": "Tender Submitted",
        "category": "event",
        "description": "Fires when a tender is submitted.",
        "default_action": "tender_submitted",
        "rules": [_rule("assignee", sort_order=10)],
        "templates": _templates(
            "Tender Submitted: {{tender_title}}",
            "Tender {{tender_title}} is now submitted.",
            action_url_template="/tenders",
        ),
    },
    {
        "module_key": "tenders",
        "event_key": "po_approved",
        "label": "Tender PO Approved",
        "category": "approval",
        "description": "Fires when tender PO details are approved.",
        "default_action": "tender_po_approved",
        "rules": [_rule("assignee", sort_order=10)],
        "templates": _templates(
            "PO Approved: {{tender_title}}",
            "PO details for tender {{tender_title}} were approved by {{actor_name}}.",
            action_url_template="/tenders",
        ),
    },
    {
        "module_key": "workorders",
        "event_key": "created",
        "label": "Work Order Created",
        "category": "event",
        "description": "Fires when a work order is created.",
        "default_action": "workorder_created",
        "rules": [
            _rule("assignee", sort_order=10),
            _rule("creator", sort_order=20),
        ],
        "templates": _templates(
            "Work Order Created: {{wo_number}}",
            "Work order {{wo_number}} was created for {{customer_name}} by {{actor_name}}.",
            action_url_template="/workorders",
        ),
    },
    {
        "module_key": "workorders",
        "event_key": "updated",
        "label": "Work Order Updated",
        "category": "event",
        "description": "Fires when a work order is updated.",
        "default_action": "workorder_updated",
        "rules": [
            _rule("assignee", sort_order=10),
            _rule("creator", sort_order=20),
        ],
        "templates": _templates(
            "Work Order Updated: {{wo_number}}",
            "Work order {{wo_number}} was updated by {{actor_name}}.",
            action_url_template="/workorders",
        ),
    },
    {
        "module_key": "workorders",
        "event_key": "po_uploaded",
        "label": "Work Order PO Uploaded",
        "category": "event",
        "description": "Fires when a work order PO file is uploaded or changed.",
        "default_action": "workorder_po_uploaded",
        "rules": [
            _rule("assignee", sort_order=10),
            _rule("creator", is_active=False, sort_order=20),
        ],
        "templates": _templates(
            "PO Updated: {{wo_number}}",
            "The PO document for work order {{wo_number}} was uploaded or changed by {{actor_name}}.",
            action_url_template="/workorders",
        ),
    },
    {
        "module_key": "workorders",
        "event_key": "progress_changed",
        "label": "Work Order Progress Changed",
        "category": "event",
        "description": "Fires when work order progress changes.",
        "default_action": "workorder_progress_changed",
        "rules": [
            _rule("assignee", sort_order=10),
            _rule("creator", sort_order=20),
        ],
        "templates": _templates(
            "Progress Updated: {{wo_number}}",
            "Work order {{wo_number}} progress is now {{progress_percent}}% with status {{status}}.",
            action_url_template="/workorders",
        ),
    },
    {
        "module_key": "workorders",
        "event_key": "completed",
        "label": "Work Order Completed",
        "category": "event",
        "description": "Fires when a work order is completed.",
        "default_action": "workorder_completed",
        "rules": [
            _rule("assignee", sort_order=10),
            _rule("creator", sort_order=20),
            _rule("manager", sort_order=30),
        ],
        "templates": _templates(
            "Work Order Completed: {{wo_number}}",
            "Work order {{wo_number}} was marked completed by {{actor_name}}.",
            action_url_template="/workorders",
        ),
    },
    {
        "module_key": "workorders",
        "event_key": "delayed_overdue",
        "label": "Work Order Delayed or Overdue",
        "category": "alert",
        "description": "Fires when a work order is delayed or overdue.",
        "default_action": "workorder_delayed_overdue",
        "rules": [
            _rule("assignee", sort_order=10),
            _rule("manager", sort_order=20),
        ],
        "templates": _templates(
            "Work Order Delayed: {{wo_number}}",
            "Work order {{wo_number}} is delayed or overdue. Current status: {{status}}.",
            action_url_template="/workorders",
        ),
    },
    {
        "module_key": "emdbg",
        "event_key": "created",
        "label": "EMD/BG Created",
        "category": "event",
        "description": "Fires when an EMD/BG record is created.",
        "default_action": "emdbg_created",
        "rules": [
            _rule("creator", sort_order=10),
            _rule("role", recipient_role="accounts", sort_order=20),
        ],
        "templates": _templates(
            "EMD/BG Created: {{reference_num}}",
            "{{instrument_type}} {{reference_num}} for {{amount}} was created by {{actor_name}}.",
            action_url_template="/emdbg",
        ),
    },
    {
        "module_key": "emdbg",
        "event_key": "approval_requested",
        "label": "EMD/BG Approval Requested",
        "category": "approval",
        "description": "Fires when EMD/BG approval is requested.",
        "default_action": "emdbg_approval_requested",
        "rules": [_rule("approver", sort_order=10)],
        "templates": _templates(
            "EMD/BG Approval Needed: {{reference_num}}",
            "{{actor_name}} requested approval for {{instrument_type}} {{reference_num}}.",
            action_url_template="/emdbg",
        ),
    },
    {
        "module_key": "emdbg",
        "event_key": "approved",
        "label": "EMD/BG Approved",
        "category": "approval",
        "description": "Fires when EMD/BG approval is granted.",
        "default_action": "emdbg_approved",
        "rules": [
            _rule("creator", sort_order=10),
            _rule("role", recipient_role="accounts", sort_order=20),
        ],
        "templates": _templates(
            "EMD/BG Approved: {{reference_num}}",
            "{{instrument_type}} {{reference_num}} was approved by {{actor_name}}.",
            action_url_template="/emdbg",
        ),
    },
    {
        "module_key": "emdbg",
        "event_key": "rejected",
        "label": "EMD/BG Rejected",
        "category": "approval",
        "description": "Fires when EMD/BG approval is rejected.",
        "default_action": "emdbg_rejected",
        "rules": [_rule("creator", sort_order=10)],
        "templates": _templates(
            "EMD/BG Rejected: {{reference_num}}",
            "{{instrument_type}} {{reference_num}} was rejected by {{actor_name}}. {{reason}}",
            action_url_template="/emdbg",
        ),
    },
    {
        "module_key": "emdbg",
        "event_key": "expiry_warning_30d",
        "label": "EMD/BG Expiry Warning (30 Days)",
        "category": "alert",
        "description": "Fires when an active EMD/BG enters the 30 day expiry window.",
        "default_action": "emdbg_expiry_warning_30d",
        "rules": [
            _rule("creator", sort_order=10),
            _rule("role", recipient_role="accounts", sort_order=20),
        ],
        "templates": _templates(
            "EMD/BG Expiry Warning: {{reference_num}}",
            "{{instrument_type}} {{reference_num}} expires on {{expiry_date}}.",
            action_url_template="/emdbg",
        ),
    },
    {
        "module_key": "emdbg",
        "event_key": "expiry_warning_7d",
        "label": "EMD/BG Expiry Warning (7 Days)",
        "category": "alert",
        "description": "Fires when an active EMD/BG enters the 7 day expiry window.",
        "default_action": "emdbg_expiry_warning_7d",
        "rules": [
            _rule("creator", sort_order=10),
            _rule("role", recipient_role="accounts", sort_order=20),
        ],
        "templates": _templates(
            "Urgent EMD/BG Expiry: {{reference_num}}",
            "{{instrument_type}} {{reference_num}} expires on {{expiry_date}}. {{days_to_expiry}} days left.",
            action_url_template="/emdbg",
        ),
    },
    {
        "module_key": "emdbg",
        "event_key": "expired",
        "label": "EMD/BG Expired",
        "category": "alert",
        "description": "Fires when an active EMD/BG has expired.",
        "default_action": "emdbg_expired",
        "rules": [
            _rule("creator", sort_order=10),
            _rule("role", recipient_role="accounts", sort_order=20),
        ],
        "templates": _templates(
            "EMD/BG Expired: {{reference_num}}",
            "{{instrument_type}} {{reference_num}} expired on {{expiry_date}}.",
            action_url_template="/emdbg",
        ),
    },
    {
        "module_key": "emdbg",
        "event_key": "renewed",
        "label": "EMD/BG Renewed",
        "category": "event",
        "description": "Fires when an EMD/BG is renewed.",
        "default_action": "emdbg_renewed",
        "rules": [
            _rule("creator", sort_order=10),
            _rule("role", recipient_role="accounts", sort_order=20),
        ],
        "templates": _templates(
            "EMD/BG Renewed: {{reference_num}}",
            "{{instrument_type}} {{reference_num}} was renewed. New expiry date: {{expiry_date}}.",
            action_url_template="/emdbg",
        ),
    },
    {
        "module_key": "emdbg",
        "event_key": "returned_released",
        "label": "EMD/BG Returned or Released",
        "category": "event",
        "description": "Fires when an EMD/BG is returned or released.",
        "default_action": "emdbg_returned_released",
        "rules": [
            _rule("creator", sort_order=10),
            _rule("role", recipient_role="accounts", sort_order=20),
        ],
        "templates": _templates(
            "EMD/BG Returned/Released: {{reference_num}}",
            "{{instrument_type}} {{reference_num}} was marked {{status}} by {{actor_name}}.",
            action_url_template="/emdbg",
        ),
    },
    {
        "module_key": "emdbg",
        "event_key": "encashed",
        "label": "EMD/BG Encashed",
        "category": "alert",
        "description": "Fires when an EMD/BG is encashed.",
        "default_action": "emdbg_encashed",
        "rules": [
            _rule("creator", sort_order=10),
            _rule("role", recipient_role="accounts", sort_order=20),
        ],
        "templates": _templates(
            "EMD/BG Encashed: {{reference_num}}",
            "{{instrument_type}} {{reference_num}} was marked encashed by {{actor_name}}.",
            action_url_template="/emdbg",
        ),
    },
    {
        "module_key": "customers",
        "event_key": "created",
        "label": "Customer Created",
        "category": "event",
        "description": "Fires when a customer is created.",
        "default_action": "customer_created",
        "rules": [_rule("customer_owner", sort_order=10)],
        "templates": _templates(
            "Customer Created: {{customer_name}}",
            "{{actor_name}} created customer {{customer_name}}.",
            action_url_template="/customers",
        ),
    },
    {
        "module_key": "customers",
        "event_key": "updated",
        "label": "Customer Updated",
        "category": "event",
        "description": "Fires when a customer is updated.",
        "default_action": "customer_updated",
        "rules": [_rule("customer_owner", sort_order=10)],
        "templates": _templates(
            "Customer Updated: {{customer_name}}",
            "{{customer_name}} was updated by {{actor_name}}.",
            action_url_template="/customers",
        ),
    },
    {
        "module_key": "customers",
        "event_key": "status_changed",
        "label": "Customer Status Changed",
        "category": "event",
        "description": "Fires when a customer account status changes.",
        "default_action": "customer_status_changed",
        "rules": [_rule("customer_owner", sort_order=10)],
        "templates": _templates(
            "Customer Status Changed: {{customer_name}}",
            "{{customer_name}} status changed from {{old_account_status}} to {{new_account_status}} by {{actor_name}}.",
            action_url_template="/customers",
        ),
    },
    {
        "module_key": "customers",
        "event_key": "potential_changed",
        "label": "Customer Potential Changed",
        "category": "event",
        "description": "Fires when a customer potential rating or potential value changes.",
        "default_action": "customer_potential_changed",
        "rules": [_rule("customer_owner", sort_order=10)],
        "templates": _templates(
            "Customer Potential Changed: {{customer_name}}",
            "{{customer_name}} potential is now {{new_account_potential}} with estimated value {{new_potential_value}}. Updated by {{actor_name}}. Previous value: {{old_potential_value}}.",
            action_url_template="/customers",
        ),
    },
    {
        "module_key": "customers",
        "event_key": "approval_requested",
        "label": "Customer Approval Requested",
        "category": "approval",
        "description": "Fires when a customer is sent for approval.",
        "default_action": "customer_approval_requested",
        "rules": [_rule("approver", sort_order=10)],
        "templates": _templates(
            "Customer Approval Needed: {{customer_name}}",
            "{{actor_name}} requested approval for customer {{customer_name}}.",
            action_url_template="/customers",
        ),
    },
    {
        "module_key": "customers",
        "event_key": "approved",
        "label": "Customer Approved",
        "category": "approval",
        "description": "Fires when a customer approval request is approved.",
        "default_action": "customer_approved",
        "rules": [_rule("customer_owner", sort_order=10)],
        "templates": _templates(
            "Customer Approved: {{customer_name}}",
            "Customer {{customer_name}} was approved by {{actor_name}}.",
            action_url_template="/customers",
        ),
    },
    {
        "module_key": "customers",
        "event_key": "rejected",
        "label": "Customer Rejected",
        "category": "approval",
        "description": "Fires when a customer approval request is rejected.",
        "default_action": "customer_rejected",
        "rules": [_rule("customer_owner", sort_order=10)],
        "templates": _templates(
            "Customer Rejected: {{customer_name}}",
            "Customer {{customer_name}} was rejected by {{actor_name}}. {{reason}}",
            action_url_template="/customers",
        ),
    },
    {
        "module_key": "customers",
        "event_key": "deleted",
        "label": "Customer Deleted",
        "category": "alert",
        "description": "Fires when a customer is deleted.",
        "default_action": "customer_deleted",
        "rules": [_rule("customer_owner", sort_order=10)],
        "templates": _templates(
            "Customer Deleted: {{customer_name}}",
            "{{actor_name}} deleted customer {{customer_name}}.",
            action_url_template="/customers",
        ),
    },
]


def ensure_dynamic_notification_tables(db: Session) -> None:
    try:
        TenantBase.metadata.create_all(
            bind=db.get_bind(),
            tables=[
                NotificationEventDefinition.__table__,
                NotificationRule.__table__,
                NotificationTemplate.__table__,
                NotificationDeliveryLog.__table__,
            ],
            checkfirst=True,
        )
    except Exception as exc:
        logger.debug("dynamic notification table ensure skipped: %s", exc)
        return

    statements = [
        "ALTER TABLE notification_delivery_logs ADD COLUMN IF NOT EXISTS resolver_key VARCHAR(100) NULL",
        "ALTER TABLE notification_delivery_logs ADD COLUMN IF NOT EXISTS recipient_kind VARCHAR(20) NULL",
        "ALTER TABLE notification_delivery_logs ADD COLUMN IF NOT EXISTS recipient_source VARCHAR(50) NULL",
    ]
    try:
        bind = db.get_bind()
        with bind.begin() as conn:
            for statement in statements:
                conn.execute(text(statement))
    except Exception as exc:
        logger.debug("dynamic notification log column ensure skipped: %s", exc)


def _dict_rule_resolver_key(rule: dict[str, Any]) -> str:
    if rule["recipient_type"] == "role":
        return f'role:{(rule.get("recipient_role") or "").strip().lower()}'
    return rule["recipient_type"]


def serialize_notification_rule_resolver_key(rule: NotificationRule) -> str:
    recipient_type = str(rule.recipient_type or "").strip().lower()
    if recipient_type == "role":
        role_key = str(rule.recipient_role or "").strip().lower()
        return f"role:{role_key}" if role_key else recipient_type
    return recipient_type


def _legacy_rule_enabled(db: Session, event_key: str, rule: dict[str, Any]) -> bool:
    default = bool(rule.get("is_active", False))
    setting_key = LEGACY_LEAD_RULE_SETTING_KEYS.get((event_key, _dict_rule_resolver_key(rule)))
    if not setting_key:
        return default
    return get_bool_setting(db, setting_key, default)


def ensure_notification_catalog_seeded(db: Session) -> None:
    ensure_dynamic_notification_tables(db)

    existing_definitions = {
        (row.module_key, row.event_key): row
        for row in db.query(NotificationEventDefinition).all()
    }

    for event in DEFAULT_EVENT_CATALOG:
        definition = existing_definitions.get((event["module_key"], event["event_key"]))
        if definition is None:
            definition = NotificationEventDefinition(
                module_key=event["module_key"],
                event_key=event["event_key"],
                label=event["label"],
                category=event["category"],
                description=event["description"],
                default_action=event["default_action"],
                is_system=True,
                is_active=True,
            )
            db.add(definition)
            db.flush()
            existing_definitions[(event["module_key"], event["event_key"])] = definition
        else:
            definition.label = event["label"]
            definition.category = event["category"]
            definition.description = event["description"]
            definition.default_action = event["default_action"]
            definition.is_system = True
            if definition.is_active is None:
                definition.is_active = True

        existing_rules = (
            db.query(NotificationRule)
            .filter(NotificationRule.event_definition_id == definition.id)
            .count()
        )
        if existing_rules == 0:
            for rule in event["rules"]:
                is_active = bool(rule.get("is_active", True))
                if event["module_key"] == "leads":
                    is_active = _legacy_rule_enabled(db, event["event_key"], rule)
                resolver_key = _dict_rule_resolver_key(rule)
                db.add(NotificationRule(
                    event_definition_id=definition.id,
                    channel=rule.get("channel", CHANNEL_BOTH),
                    recipient_type=resolver_key,
                    recipient_role=None if resolver_key.startswith("role:") else rule.get("recipient_role"),
                    recipient_user_id=rule.get("recipient_user_id"),
                    record_field_name=rule.get("record_field_name"),
                    condition_json=rule.get("condition_json"),
                    is_active=is_active,
                    sort_order=int(rule.get("sort_order", 0) or 0),
                ))

        existing_templates = {
            row.channel: row
            for row in db.query(NotificationTemplate)
            .filter(NotificationTemplate.event_definition_id == definition.id)
            .all()
        }
        for channel, template in event["templates"].items():
            existing = existing_templates.get(channel)
            if existing is None:
                db.add(NotificationTemplate(
                    event_definition_id=definition.id,
                    channel=channel,
                    subject_template=template.get("subject_template"),
                    body_template=template.get("body_template"),
                    html_template=template.get("html_template"),
                    action_url_template=template.get("action_url_template"),
                    is_active=bool(template.get("is_active", True)),
                ))
            else:
                if not existing.subject_template:
                    existing.subject_template = template.get("subject_template")
                if not existing.body_template:
                    existing.body_template = template.get("body_template")
                if not existing.action_url_template:
                    existing.action_url_template = template.get("action_url_template")
                if existing.is_active is None:
                    existing.is_active = True

    db.flush()


def list_supported_notification_modules() -> list[dict[str, str]]:
    return [{"key": key, "label": value} for key, value in MODULE_LABELS.items()]


def resolve_event_definition(db: Session, module_key: str, event_key: str) -> Optional[NotificationEventDefinition]:
    ensure_notification_catalog_seeded(db)
    normalized_module_key = normalize_notification_module_key(module_key)
    return (
        db.query(NotificationEventDefinition)
        .filter(
            NotificationEventDefinition.module_key == normalized_module_key,
            NotificationEventDefinition.event_key == event_key,
        )
        .first()
    )


def _normalize_context_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, Decimal):
        text = format(value, "f")
        return text.rstrip("0").rstrip(".") if "." in text else text
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def notification_values_equal(left: Any, right: Any) -> bool:
    if isinstance(left, (int, float, Decimal)) and isinstance(right, (int, float, Decimal)) and not isinstance(left, bool) and not isinstance(right, bool):
        try:
            return Decimal(str(left)) == Decimal(str(right))
        except Exception:
            pass
    return _normalize_context_value(left).strip() == _normalize_context_value(right).strip()


def build_notification_change_context(
    *,
    changes: Optional[dict[str, Any]] = None,
    field_labels: Optional[dict[str, str]] = None,
    notes: Optional[list[str]] = None,
) -> dict[str, Any]:
    context: dict[str, Any] = {}
    normalized_labels = {str(key): str(value) for key, value in (field_labels or {}).items() if key and value}

    for field_key, payload in (changes or {}).items():
        label = None
        old_value: Any = None
        new_value: Any = None
        if isinstance(payload, dict):
            old_value = payload.get("old")
            new_value = payload.get("new")
            label = payload.get("label")
        elif isinstance(payload, (list, tuple)) and len(payload) >= 2:
            old_value, new_value = payload[0], payload[1]
        else:
            continue

        normalized_field_key = str(field_key or "").strip()
        if not normalized_field_key:
            continue

        context[f"old_{normalized_field_key}"] = old_value
        context[f"new_{normalized_field_key}"] = new_value
        if label:
            normalized_labels[normalized_field_key] = str(label)

    if normalized_labels:
        context["field_labels"] = normalized_labels
    if notes:
        context["notification_notes"] = [str(note).strip() for note in notes if str(note).strip()]
    return context


def _coerce_datetime(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        if raw.endswith("Z"):
            raw = f"{raw[:-1]}+00:00"
        try:
            return datetime.fromisoformat(raw)
        except ValueError:
            return None
    return None


def _format_numeric_value(value: Any) -> str:
    try:
        decimal_value = Decimal(str(value))
    except Exception:
        return _normalize_context_value(value)
    text = format(decimal_value, ",f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def _format_notification_timestamp(value: Any) -> str:
    dt_value = _coerce_datetime(value)
    if dt_value:
        if dt_value.tzinfo is not None:
            dt_value = dt_value.astimezone()
        return dt_value.strftime("%d %b %Y, %I:%M %p")
    if isinstance(value, date):
        return value.strftime("%d %b %Y")
    text = _normalize_context_value(value).strip()
    return text or now_ist().strftime("%d %b %Y, %I:%M %p")


def _format_display_value(value: Any, field_key: Optional[str] = None) -> str:
    normalized_field_key = str(field_key or "").strip()
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, datetime):
        return _format_notification_timestamp(value)
    if isinstance(value, date):
        return value.strftime("%d %b %Y")
    if normalized_field_key in AMOUNT_FIELD_KEYS and isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        return _format_numeric_value(value)
    if normalized_field_key == "progress_percent" and isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        numeric = _format_numeric_value(value)
        return f"{numeric}%" if numeric else ""
    text = _normalize_context_value(value).strip()
    if normalized_field_key in AMOUNT_FIELD_KEYS and text:
        return _format_numeric_value(text)
    if normalized_field_key == "progress_percent" and text and not text.endswith("%"):
        return f"{text}%"
    return text


def _humanize_notification_field_name(field_key: str) -> str:
    normalized_field_key = str(field_key or "").strip()
    if not normalized_field_key:
        return "Field"
    if normalized_field_key in FIELD_LABEL_OVERRIDES:
        return FIELD_LABEL_OVERRIDES[normalized_field_key]
    return normalized_field_key.replace("_", " ").strip().title()


def _is_user_reference_field(field_key: str) -> bool:
    normalized_field_key = str(field_key or "").strip()
    return normalized_field_key in USER_REFERENCE_FIELD_KEYS or normalized_field_key.endswith("_user_id")


def _resolve_user_display_name(db: Session, value: Any) -> str:
    if value is None or value == "":
        return ""
    try:
        user_id = int(value)
    except Exception:
        return _normalize_context_value(value).strip()
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return str(user_id)
    return str(getattr(user, "full_name", "") or getattr(user, "username", "") or getattr(user, "email", "") or user_id).strip()


def _inject_display_overrides(db: Session, context: dict[str, Any]) -> None:
    display_values = dict(context.get("display_values") or {})

    for key, value in list(context.items()):
        normalized_key = str(key or "").strip()
        if not normalized_key:
            continue

        if normalized_key.startswith(("old_", "new_")):
            field_key = normalized_key[4:]
            if _is_user_reference_field(field_key):
                display_values[normalized_key] = _resolve_user_display_name(db, value)
            continue

        if _is_user_reference_field(normalized_key):
            display_values[normalized_key] = _resolve_user_display_name(db, value)

    if display_values:
        context["display_values"] = display_values


def _get_frontend_base_url() -> str:
    configured = str(getattr(settings, "FRONTEND_BASE_URL", "") or "").strip().rstrip("/")
    if configured:
        return configured

    for origin in getattr(settings, "ALLOWED_ORIGINS", []) or []:
        normalized_origin = str(origin or "").strip().rstrip("/")
        if not normalized_origin or normalized_origin == "*":
            continue
        if normalized_origin.startswith(("http://localhost", "https://localhost", "http://127.0.0.1", "https://127.0.0.1")):
            continue
        return normalized_origin

    for origin in getattr(settings, "ALLOWED_ORIGINS", []) or []:
        normalized_origin = str(origin or "").strip().rstrip("/")
        if normalized_origin.startswith(("http://", "https://")):
            return normalized_origin
    return ""


def _build_absolute_action_url(action_url: str) -> str:
    normalized_action_url = str(action_url or "").strip()
    if not normalized_action_url:
        return ""
    if normalized_action_url.startswith(("http://", "https://")):
        return normalized_action_url

    frontend_base_url = _get_frontend_base_url()
    if not frontend_base_url:
        return normalized_action_url
    return urljoin(f"{frontend_base_url}/", normalized_action_url.lstrip("/"))


def _build_notification_action_label(module_key: str, event_name: str) -> str:
    action_label = str(event_name or "").strip()
    module_label = MODULE_LABELS.get(module_key, "")
    entity_label = MODULE_ENTITY_LABELS.get(module_key, "")

    for prefix in (module_label, entity_label):
        prefix_text = str(prefix or "").strip()
        if prefix_text and action_label.lower().startswith(f"{prefix_text.lower()} "):
            action_label = action_label[len(prefix_text):].strip()

    if entity_label and action_label.lower().endswith(f" {entity_label.lower()}"):
        action_label = action_label[: -len(entity_label)].strip()

    return action_label or event_name or "Updated"


def _collect_notification_change_items(context: dict[str, Any]) -> list[dict[str, str]]:
    field_labels = context.get("field_labels") if isinstance(context.get("field_labels"), dict) else {}
    display_values = context.get("display_values") if isinstance(context.get("display_values"), dict) else {}
    items: list[dict[str, str]] = []
    seen_fields: set[str] = set()

    for key in sorted(context.keys()):
        if not key.startswith("old_"):
            continue
        field_key = key[4:]
        new_key = f"new_{field_key}"
        if new_key not in context or field_key in seen_fields:
            continue

        old_value = context.get(key)
        new_value = context.get(new_key)
        if notification_values_equal(old_value, new_value):
            continue

        seen_fields.add(field_key)
        items.append(
            {
                "field_key": field_key,
                "label": str(field_labels.get(field_key) or _humanize_notification_field_name(field_key)),
                "old_text": str(display_values.get(key) or _format_display_value(old_value, field_key) or "-"),
                "new_text": str(display_values.get(new_key) or _format_display_value(new_value, field_key) or "-"),
            }
        )

    return items


def _collect_notification_detail_items(module_key: str, context: dict[str, Any]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    seen_labels: set[str] = set()
    for label, field_key in MODULE_EMAIL_DETAIL_FIELDS.get(module_key, ()):
        formatted_value = _format_display_value(context.get(field_key), field_key)
        if not formatted_value or label in seen_labels:
            continue
        seen_labels.add(label)
        items.append({"label": label, "value": formatted_value})
    return items


def _collect_notification_notes(context: dict[str, Any]) -> list[str]:
    raw_notes = context.get("notification_notes")
    if isinstance(raw_notes, str):
        raw_notes = [raw_notes]
    if not isinstance(raw_notes, (list, tuple)):
        return []
    return [str(note).strip() for note in raw_notes if str(note).strip()]


def _build_notification_email_text(
    *,
    module_key: str,
    definition: NotificationEventDefinition,
    summary_text: str,
    context: dict[str, Any],
    action_url: str,
) -> str:
    entity_label = MODULE_ENTITY_LABELS.get(module_key, "Record")
    record_value = (
        _format_display_value(context.get("record_ref"))
        or _format_display_value(context.get("lead_title"))
        or _format_display_value(context.get("tender_title"))
        or _format_display_value(context.get("wo_number"))
        or _format_display_value(context.get("reference_num"))
        or _format_display_value(context.get("customer_name"))
        or "-"
    )
    action_label = _build_notification_action_label(module_key, definition.label)
    actor_name = _format_display_value(context.get("actor_name")) or "System"
    event_time = _format_notification_timestamp(context.get("event_time"))
    detail_items = _collect_notification_detail_items(module_key, context)
    change_items = _collect_notification_change_items(context)
    notes = _collect_notification_notes(context)

    lines: list[str] = []
    if summary_text.strip():
        lines.extend([summary_text.strip(), ""])

    lines.extend(
        [
            f"{entity_label}: {record_value}",
            f"Action: {action_label}",
            f"By: {actor_name}",
            f"Time: {event_time}",
        ]
    )

    if detail_items:
        lines.append("")
        lines.append("Details:")
        lines.extend(f"- {item['label']}: {item['value']}" for item in detail_items)

    if change_items or notes:
        lines.append("")
        lines.append("Changes:")
        lines.extend(f"- {item['label']}: {item['old_text']} -> {item['new_text']}" for item in change_items)
        lines.extend(f"- {note}" for note in notes)

    if action_url:
        lines.extend(["", f"Open in CRM: {action_url}"])

    return "\n".join(lines).strip()


def _build_notification_email_html(
    *,
    subject: str,
    module_key: str,
    definition: NotificationEventDefinition,
    summary_text: str,
    context: dict[str, Any],
    action_url: str,
) -> str:
    entity_label = MODULE_ENTITY_LABELS.get(module_key, "Record")
    record_value = (
        _format_display_value(context.get("record_ref"))
        or _format_display_value(context.get("lead_title"))
        or _format_display_value(context.get("tender_title"))
        or _format_display_value(context.get("wo_number"))
        or _format_display_value(context.get("reference_num"))
        or _format_display_value(context.get("customer_name"))
        or "-"
    )
    action_label = _build_notification_action_label(module_key, definition.label)
    actor_name = _format_display_value(context.get("actor_name")) or "System"
    event_time = _format_notification_timestamp(context.get("event_time"))
    detail_items = _collect_notification_detail_items(module_key, context)
    change_items = _collect_notification_change_items(context)
    notes = _collect_notification_notes(context)

    def detail_row(label: str, value: str) -> str:
        return (
            '<tr>'
            f'<td style="padding:10px 0;color:#64748b;font-size:13px;font-weight:600;vertical-align:top;">{escape(label)}</td>'
            f'<td style="padding:10px 0;color:#0f172a;font-size:14px;font-weight:600;">{escape(value)}</td>'
            "</tr>"
        )

    detail_rows = "".join(
        detail_row(label, value)
        for label, value in (
            (entity_label, record_value),
            ("Action", action_label),
            ("By", actor_name),
            ("Time", event_time),
        )
    )

    if detail_items:
        detail_rows += "".join(detail_row(item["label"], item["value"]) for item in detail_items)

    changes_block = ""
    if change_items or notes:
        change_lines = "".join(
            (
                '<li style="margin:0 0 10px 0;color:#334155;font-size:14px;line-height:1.6;">'
                f"<strong>{escape(item['label'])}:</strong> "
                f"{escape(item['old_text'])} &rarr; {escape(item['new_text'])}"
                "</li>"
            )
            for item in change_items
        )
        note_lines = "".join(
            f'<li style="margin:0 0 10px 0;color:#334155;font-size:14px;line-height:1.6;">{escape(note)}</li>'
            for note in notes
        )
        changes_block = (
            '<div style="margin-top:24px;padding:20px 22px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;">'
            '<h3 style="margin:0 0 12px 0;font-size:15px;color:#0f172a;">Changes</h3>'
            f'<ul style="margin:0;padding-left:20px;">{change_lines}{note_lines}</ul>'
            "</div>"
        )

    summary_block = ""
    if summary_text.strip():
        summary_block = (
            '<div style="margin:0 0 20px 0;padding:16px 18px;background:#eff6ff;border:1px solid #bfdbfe;'
            'border-radius:16px;color:#1e3a8a;font-size:14px;line-height:1.7;">'
            f"{escape(summary_text).replace(chr(10), '<br/>')}"
            "</div>"
        )

    action_block = ""
    if action_url:
        action_block = (
            '<p style="margin:24px 0 0;">'
            f'<a href="{escape(action_url)}" '
            'style="display:inline-block;padding:12px 18px;border-radius:10px;'
            'background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;">'
            "Open in CRM"
            "</a></p>"
        )

    return (
        '<div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;">'
        '<div style="max-width:700px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;'
        'border-radius:18px;overflow:hidden;">'
        '<div style="padding:22px 24px;background:#0f172a;color:#ffffff;">'
        f'<h2 style="margin:0;font-size:22px;line-height:1.3;">{escape(subject)}</h2>'
        "</div>"
        '<div style="padding:24px;color:#334155;">'
        f"{summary_block}"
        '<div style="padding:18px 22px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;">'
        '<table role="presentation" style="width:100%;border-collapse:collapse;">'
        f"{detail_rows}"
        "</table>"
        "</div>"
        f"{changes_block}"
        f"{action_block}"
        "</div>"
        "</div>"
        "</div>"
    )


def _render_template(template: Optional[str], context: dict[str, Any]) -> str:
    raw_template = template or ""

    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        return _normalize_context_value(context.get(key))

    return PLACEHOLDER_RE.sub(replace, raw_template)


def _load_tenant_for_session(db: Session) -> Optional[Tenant]:
    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    if not tenant_slug:
        return None

    master_db = MasterSessionLocal()
    try:
        tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
        if tenant:
            master_db.expunge(tenant)
        return tenant
    finally:
        master_db.close()


def _basic_html_body(subject: str, body: str, action_url: Optional[str]) -> str:
    action_block = ""
    if action_url:
        action_block = (
            f'<p style="margin:24px 0 0;">'
            f'<a href="{escape(action_url)}" '
            'style="display:inline-block;padding:12px 18px;border-radius:10px;'
            'background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;">'
            "Open In CRM"
            "</a></p>"
        )
    return (
        '<div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;">'
        '<div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;'
        'border-radius:18px;overflow:hidden;">'
        '<div style="padding:20px 24px;background:#0f172a;color:#ffffff;">'
        f'<h2 style="margin:0;font-size:22px;line-height:1.3;">{escape(subject)}</h2>'
        "</div>"
        '<div style="padding:24px;color:#334155;">'
        f'<p style="margin:0;font-size:15px;line-height:1.7;">{escape(body).replace(chr(10), "<br/>")}</p>'
        f"{action_block}"
        "</div>"
        "</div>"
        "</div>"
    )


def _send_email_to_address(
    db: Session,
    recipient_email: str,
    *,
    subject: str,
    text_body: str,
    html_body: Optional[str],
    category: str,
) -> bool:
    if not recipient_email or not is_email_enabled_for_category(db, category):
        return False

    tenant = _load_tenant_for_session(db)
    if not tenant:
        return False

    try:
        send_tenant_email(
            tenant=tenant,
            to_email=recipient_email,
            subject=subject,
            text_body=text_body,
            html_body=html_body,
        )
        return True
    except (TenantEmailConfigurationError, TenantEmailDeliveryError) as exc:
        logger.warning(
            "dynamic notification email skipped for tenant=%s email=%s: %s",
            getattr(tenant, "slug", "unknown"),
            recipient_email,
            exc,
        )
        return False
    except Exception as exc:
        logger.exception("unexpected dynamic email failure for %s: %s", recipient_email, exc)
        return False


def _get_active_user(db: Session, user_id: Optional[int]) -> Optional[User]:
    if not user_id:
        return None
    return db.query(User).filter(User.id == int(user_id), User.is_active == True).first()


def _get_role_users(db: Session, role_name: str) -> list[User]:
    roles = ROLE_ALIASES.get(role_name, (role_name,))
    return list(db.query(User).filter(User.role.in_(roles), User.is_active == True).all())


def _find_active_user_by_email(db: Session, email: Optional[str]) -> Optional[User]:
    normalized_email = str(email or "").strip().lower()
    if not normalized_email:
        return None
    return db.query(User).filter(User.email.ilike(normalized_email), User.is_active == True).first()


def _normalize_email(email: Optional[str]) -> str:
    return str(email or "").strip().lower()


def _build_internal_recipient(
    user: Optional[User],
    *,
    resolver_key: str,
    source: str,
) -> Optional[dict[str, Any]]:
    if user is None or not getattr(user, "id", None):
        return None
    email = _normalize_email(getattr(user, "email", None))
    return {
        "type": "internal",
        "user_id": int(user.id),
        "email": email or None,
        "resolver_key": resolver_key,
        "source": source,
        "user": user,
    }


def _build_external_recipient(
    email: Optional[str],
    *,
    resolver_key: str,
    source: str,
) -> Optional[dict[str, Any]]:
    normalized_email = _normalize_email(email)
    if not normalized_email:
        return None
    return {
        "type": "external",
        "user_id": None,
        "email": normalized_email,
        "resolver_key": resolver_key,
        "source": source,
        "user": None,
    }


def _recipient_from_email_or_user(
    db: Session,
    email: Optional[str],
    *,
    resolver_key: str,
    external_source: str,
) -> Optional[dict[str, Any]]:
    normalized_email = _normalize_email(email)
    if not normalized_email:
        return None
    matched_user = _find_active_user_by_email(db, normalized_email)
    if matched_user:
        return _build_internal_recipient(
            matched_user,
            resolver_key=resolver_key,
            source="email_match",
        )
    return _build_external_recipient(
        normalized_email,
        resolver_key=resolver_key,
        source=external_source,
    )


def _first_existing_attr(record: Any, field_names: tuple[str, ...]) -> Any:
    for field_name in field_names:
        value = getattr(record, field_name, None)
        if value is not None:
            return value
    return None


def _load_record(db: Session, module_key: str, record_id: Optional[int]) -> Any:
    model = MODULE_RECORD_MODELS.get(normalize_notification_module_key(module_key))
    if model is None or not record_id:
        return None
    return db.query(model).filter(model.id == int(record_id)).first()


def _resolve_manager_user(
    db: Session,
    *,
    customer_owner_user: Optional[User] = None,
    assignee_user: Optional[User] = None,
    requester_user: Optional[User] = None,
    creator_user: Optional[User] = None,
) -> Optional[User]:
    for candidate in (customer_owner_user, assignee_user, requester_user, creator_user):
        manager_id = getattr(candidate, "reporting_manager_id", None) if candidate else None
        if manager_id:
            manager = _get_active_user(db, manager_id)
            if manager and (not candidate or manager.id != candidate.id):
                return manager
    return None


def _condition_matches(rule: NotificationRule, record: Any, context: dict[str, Any]) -> bool:
    condition = rule.condition_json
    if not condition:
        return True

    values: dict[str, Any] = dict(context)
    if record is not None:
        values.update({column.name: getattr(record, column.name, None) for column in record.__table__.columns})

    if not isinstance(condition, dict):
        return True

    for key, expected in condition.items():
        actual = values.get(key)
        if isinstance(expected, dict):
            if "eq" in expected and actual != expected["eq"]:
                return False
            if "in" in expected and actual not in set(expected["in"] or []):
                return False
            if "gt" in expected and not (actual is not None and actual > expected["gt"]):
                return False
            if "gte" in expected and not (actual is not None and actual >= expected["gte"]):
                return False
            if "lt" in expected and not (actual is not None and actual < expected["lt"]):
                return False
            if "lte" in expected and not (actual is not None and actual <= expected["lte"]):
                return False
        elif actual != expected:
            return False

    return True


def _resolve_customer_record(
    db: Session,
    *,
    module_key: str,
    record: Any,
    context: dict[str, Any],
) -> Optional[Customer]:
    normalized_module_key = normalize_notification_module_key(module_key)
    if normalized_module_key == "customers" and isinstance(record, Customer):
        return record

    customer_id = context.get("customer_id") or getattr(record, "customer_id", None)
    if not customer_id and normalized_module_key == "customers":
        customer_id = getattr(record, "id", None)
    if not customer_id:
        return None
    return db.query(Customer).filter(Customer.id == int(customer_id)).first()


def _resolve_customer_owner_user(
    db: Session,
    *,
    customer_record: Optional[Customer],
) -> Optional[User]:
    if customer_record is None:
        return None

    assignment = (
        db.query(SalesCustomerAssignment)
        .filter(
            SalesCustomerAssignment.customer_id == customer_record.id,
            SalesCustomerAssignment.is_active == True,
        )
        .order_by(SalesCustomerAssignment.id.asc())
        .first()
    )
    if assignment and assignment.user_id:
        owner_user = _get_active_user(db, assignment.user_id)
        if owner_user:
            return owner_user
    return _get_active_user(db, getattr(customer_record, "assigned_to", None))


def _resolve_customer_contact_emails(
    db: Session,
    *,
    customer_record: Optional[Customer],
    primary_only: bool,
) -> list[str]:
    if customer_record is None:
        return []

    rows = (
        db.query(CustomerContact)
        .filter(
            CustomerContact.customer_id == customer_record.id,
            CustomerContact.is_active == True,
        )
        .order_by(CustomerContact.is_primary.desc(), CustomerContact.id.asc())
        .all()
    )
    if primary_only:
        rows = [row for row in rows if row.is_primary] or rows[:1]

    emails: list[str] = []
    for row in rows:
        for email_value in (row.office_email, row.personal_email):
            normalized_email = str(email_value or "").strip()
            if normalized_email:
                emails.append(normalized_email)
                if primary_only:
                    return _dedupe_strs(emails)
    return _dedupe_strs(emails)


def _recipient_identity_key(recipient: Optional[dict[str, Any]]) -> Optional[tuple[str, str]]:
    if not recipient:
        return None
    user_id = recipient.get("user_id")
    if user_id:
        return ("user", str(int(user_id)))
    email = _normalize_email(recipient.get("email"))
    if email:
        return ("email", email)
    return None


def _append_unique_recipient(results: list[dict[str, Any]], seen_targets: set[tuple[str, str]], recipient: Optional[dict[str, Any]]) -> None:
    if not recipient:
        return
    key = _recipient_identity_key(recipient)
    if not key:
        return
    if key in seen_targets:
        return
    seen_targets.add(key)
    results.append(recipient)


def resolve_recipients(
    db: Session,
    *,
    module_key: str,
    record: Any,
    recipients: list[str],
    context: Optional[dict[str, Any]] = None,
) -> list[dict[str, Any]]:
    normalized_module_key = normalize_notification_module_key(module_key)
    config = MODULE_RECORD_CONFIG.get(normalized_module_key, {})
    payload = dict(context or {})
    assignee_user = _get_active_user(
        db,
        payload.get("assignee_user_id") or _first_existing_attr(record, config.get("assignee_fields", ())),
    )
    creator_user = _get_active_user(
        db,
        payload.get("creator_user_id") or payload.get("requester_user_id") or _first_existing_attr(record, config.get("creator_fields", ())),
    )
    requester_user = _get_active_user(db, payload.get("requester_user_id")) or creator_user
    approver_user = _get_active_user(db, payload.get("approver_user_id"))
    customer_record = _resolve_customer_record(
        db,
        module_key=normalized_module_key,
        record=record,
        context=payload,
    )
    customer_owner_user = _get_active_user(db, payload.get("customer_owner_user_id")) or _resolve_customer_owner_user(
        db,
        customer_record=customer_record,
    )
    manager_user = _get_active_user(db, payload.get("manager_user_id")) or _resolve_manager_user(
        db,
        customer_owner_user=customer_owner_user,
        assignee_user=assignee_user,
        requester_user=requester_user,
        creator_user=creator_user,
    )
    results: list[dict[str, Any]] = []
    seen_targets: set[tuple[str, str]] = set()

    for resolver_key in recipients:
        normalized_resolver_key = str(resolver_key or "").strip().lower()
        if normalized_resolver_key == "assignee":
            _append_unique_recipient(
                results,
                seen_targets,
                _build_internal_recipient(
                    assignee_user,
                    resolver_key=normalized_resolver_key,
                    source="rule_engine",
                ),
            )
            continue
        if normalized_resolver_key == "creator":
            _append_unique_recipient(
                results,
                seen_targets,
                _build_internal_recipient(
                    creator_user,
                    resolver_key=normalized_resolver_key,
                    source="rule_engine",
                ),
            )
            continue
        if normalized_resolver_key == "requester":
            _append_unique_recipient(
                results,
                seen_targets,
                _build_internal_recipient(
                    requester_user,
                    resolver_key=normalized_resolver_key,
                    source="rule_engine",
                ),
            )
            continue
        if normalized_resolver_key == "approver":
            _append_unique_recipient(
                results,
                seen_targets,
                _build_internal_recipient(
                    approver_user,
                    resolver_key=normalized_resolver_key,
                    source="rule_engine",
                ),
            )
            continue
        if normalized_resolver_key == "manager":
            _append_unique_recipient(
                results,
                seen_targets,
                _build_internal_recipient(
                    manager_user,
                    resolver_key=normalized_resolver_key,
                    source="rule_engine",
                ),
            )
            continue
        if normalized_resolver_key.startswith("role:"):
            role_key = normalized_resolver_key.split(":", 1)[1]
            for role_user in _get_role_users(db, role_key):
                _append_unique_recipient(
                    results,
                    seen_targets,
                    _build_internal_recipient(
                        role_user,
                        resolver_key=normalized_resolver_key,
                        source="role_lookup",
                    ),
                )
            continue
        if normalized_resolver_key == "customer_owner":
            _append_unique_recipient(
                results,
                seen_targets,
                _build_internal_recipient(
                    customer_owner_user,
                    resolver_key=normalized_resolver_key,
                    source="rule_engine",
                ),
            )
            continue
        if normalized_resolver_key == "customer_primary_contact":
            for email_value in _resolve_customer_contact_emails(
                db,
                customer_record=customer_record,
                primary_only=True,
            ):
                _append_unique_recipient(
                    results,
                    seen_targets,
                    _recipient_from_email_or_user(
                        db,
                        email_value,
                        resolver_key=normalized_resolver_key,
                        external_source="customer_contact",
                    ),
                )
            continue
        if normalized_resolver_key == "customer_all_contacts":
            for email_value in _resolve_customer_contact_emails(
                db,
                customer_record=customer_record,
                primary_only=False,
            ):
                _append_unique_recipient(
                    results,
                    seen_targets,
                    _recipient_from_email_or_user(
                        db,
                        email_value,
                        resolver_key=normalized_resolver_key,
                        external_source="customer_contact",
                    ),
                )
            continue
        if normalized_resolver_key == "record_email":
            field_name = str(payload.get("record_field_name") or "").strip()
            if field_name and record is not None:
                _append_unique_recipient(
                    results,
                    seen_targets,
                    _recipient_from_email_or_user(
                        db,
                        getattr(record, field_name, None),
                        resolver_key=normalized_resolver_key,
                        external_source="record_email",
                    ),
                )
                continue
            for fallback_field in config.get("email_fields", ()):
                email_value = getattr(record, fallback_field, None) if record is not None else None
                if email_value:
                    _append_unique_recipient(
                        results,
                        seen_targets,
                        _recipient_from_email_or_user(
                            db,
                            email_value,
                            resolver_key=normalized_resolver_key,
                            external_source="record_email",
                        ),
                    )
                    break
            else:
                _append_unique_recipient(
                    results,
                    seen_targets,
                    _recipient_from_email_or_user(
                        db,
                        payload.get("record_email"),
                        resolver_key=normalized_resolver_key,
                        external_source="record_email",
                    ),
                )

    return results


def _resolve_recipients(
    db: Session,
    *,
    rule: NotificationRule,
    module_key: str,
    record: Any,
    context: dict[str, Any],
) -> list[dict[str, Any]]:
    resolver_key = serialize_notification_rule_resolver_key(rule)
    payload = dict(context)
    if (rule.record_field_name or "").strip():
        payload.setdefault("record_field_name", rule.record_field_name)
    return resolve_recipients(
        db,
        module_key=module_key,
        record=record,
        recipients=[resolver_key],
        context=payload,
    )


def _recipient_delivery_channels(recipient: dict[str, Any], rule_channel: str = CHANNEL_BOTH) -> tuple[str, ...]:
    candidate_channels = (CHANNEL_IN_APP, CHANNEL_EMAIL) if recipient.get("type") == "internal" else (CHANNEL_EMAIL,)
    if rule_channel == CHANNEL_BOTH:
        return candidate_channels
    return tuple(channel for channel in candidate_channels if channel == rule_channel)


def _merge_preview_recipient(
    preview_map: dict[tuple[str, str], dict[str, Any]],
    recipient: dict[str, Any],
    *,
    rule_channel: str,
) -> None:
    identity_key = _recipient_identity_key(recipient)
    if not identity_key:
        return

    entry = preview_map.get(identity_key)
    if entry is None:
        preview_map[identity_key] = {
            "type": recipient.get("type"),
            "user_id": recipient.get("user_id"),
            "email": recipient.get("email"),
            "resolver_keys": [recipient.get("resolver_key")] if recipient.get("resolver_key") else [],
            "sources": [recipient.get("source")] if recipient.get("source") else [],
            "delivery_channels": list(_recipient_delivery_channels(recipient, rule_channel)),
        }
        return

    resolver_key = recipient.get("resolver_key")
    if resolver_key and resolver_key not in entry["resolver_keys"]:
        entry["resolver_keys"].append(resolver_key)
    source = recipient.get("source")
    if source and source not in entry["sources"]:
        entry["sources"].append(source)
    for channel in _recipient_delivery_channels(recipient, rule_channel):
        if channel not in entry["delivery_channels"]:
            entry["delivery_channels"].append(channel)


def preview_notification_event(
    db: Session,
    *,
    module_key: str,
    event_key: str,
    record_id: Optional[int],
    actor_user_id: Optional[int] = None,
    context: Optional[dict[str, Any]] = None,
    skip_actor: bool = False,
) -> dict[str, Any]:
    payload = dict(context or {})
    normalized_module_key = normalize_notification_module_key(module_key)
    definition = resolve_event_definition(db, normalized_module_key, event_key)
    if not definition or not definition.is_active:
        return {
            "event_found": False,
            "module_key": normalized_module_key,
            "event_key": event_key,
            "record_id": record_id,
            "recipients": [],
        }

    record = _load_record(db, normalized_module_key, record_id)
    rules = (
        db.query(NotificationRule)
        .filter(
            NotificationRule.event_definition_id == definition.id,
            NotificationRule.is_active == True,
        )
        .order_by(NotificationRule.sort_order.asc(), NotificationRule.id.asc())
        .all()
    )
    base_context = _build_common_context(
        db,
        module_key=normalized_module_key,
        definition=definition,
        record=record,
        record_id=record_id,
        actor_user_id=actor_user_id,
        context=payload,
    )

    preview_map: dict[tuple[str, str], dict[str, Any]] = {}
    for rule in rules:
        if not _condition_matches(rule, record, base_context):
            continue

        for recipient in _resolve_recipients(
            db,
            rule=rule,
            module_key=normalized_module_key,
            record=record,
            context=base_context,
        ):
            if skip_actor and actor_user_id and recipient.get("type") == "internal" and recipient.get("user_id") == int(actor_user_id):
                continue
            _merge_preview_recipient(preview_map, recipient, rule_channel=rule.channel)

    recipients = sorted(
        preview_map.values(),
        key=lambda item: (
            str(item.get("type") or ""),
            int(item.get("user_id") or 0),
            str(item.get("email") or ""),
        ),
    )
    return {
        "event_found": True,
        "module_key": normalized_module_key,
        "event_key": event_key,
        "record_id": record_id,
        "recipients": recipients,
    }


def _build_record_reference(module_key: str, record: Any, context: dict[str, Any]) -> str:
    if context.get("record_ref"):
        return _normalize_context_value(context["record_ref"])

    config = MODULE_RECORD_CONFIG.get(module_key, {})
    parts = [
        _normalize_context_value(_first_existing_attr(record, config.get("record_ref_fields", ())))
        if record is not None else "",
        _normalize_context_value(context.get("record_title") or context.get("title_hint")),
    ]
    normalized = [part for part in parts if part]
    return " - ".join(dict.fromkeys(normalized))


def _build_common_context(
    db: Session,
    *,
    module_key: str,
    definition: NotificationEventDefinition,
    record: Any,
    record_id: Optional[int],
    actor_user_id: Optional[int],
    context: dict[str, Any],
) -> dict[str, Any]:
    actor = _get_active_user(db, actor_user_id)
    record_ref = _build_record_reference(module_key, record, context)
    module_route = MODULE_ROUTES.get(module_key, "/")
    requester_user = _get_active_user(db, context.get("requester_user_id"))
    approver_user = _get_active_user(db, context.get("approver_user_id"))
    customer_owner_user = _get_active_user(db, context.get("customer_owner_user_id"))
    base_context: dict[str, Any] = {
        "module_key": module_key,
        "module_name": MODULE_LABELS.get(module_key, module_key.replace("_", " ").title()),
        "event_key": definition.event_key,
        "event_name": definition.label,
        "record_id": record_id or getattr(record, "id", None) or "",
        "record_ref": record_ref,
        "actor_name": getattr(actor, "full_name", "") if actor else "",
        "actor_email": getattr(actor, "email", "") if actor else "",
        "company_name": (get_setting_value(db, "company_name", "AZCENTRIX") or "AZCENTRIX").strip() or "AZCENTRIX",
        "created_at": _normalize_context_value(getattr(record, "created_at", None) or now_ist()),
        "event_time": context.get("event_time") or getattr(record, "updated_at", None) or now_ist(),
        "action_url": str(context.get("action_url") or module_route),
        "status": _normalize_context_value(context.get("status") or getattr(record, "status", "")),
        "reason": _normalize_context_value(context.get("reason") or context.get("rejection_reason") or ""),
        "requester_name": getattr(requester_user, "full_name", "") if requester_user else "",
        "approver_name": getattr(approver_user, "full_name", "") if approver_user else "",
        "customer_owner_name": getattr(customer_owner_user, "full_name", "") if customer_owner_user else "",
    }

    if record is not None:
        for column in record.__table__.columns:
            base_context.setdefault(column.name, getattr(record, column.name, None))

    assignee_user = _get_active_user(
        db,
        context.get("assignee_user_id") or _first_existing_attr(record, MODULE_RECORD_CONFIG.get(module_key, {}).get("assignee_fields", ())),
    )
    base_context["assignee_name"] = getattr(assignee_user, "full_name", "") if assignee_user else "Unassigned"

    if module_key == "leads":
        base_context.setdefault("lead_title", _normalize_context_value(getattr(record, "lead_title", "")))
        base_context.setdefault("lead_ref_id", _normalize_context_value(getattr(record, "lead_ref_id", "")))
        base_context.setdefault("tender_num", _normalize_context_value(context.get("tender_num")))
    elif module_key == "tenders":
        base_context.setdefault("tender_num", _normalize_context_value(getattr(record, "tender_num", "")))
        base_context.setdefault("tender_title", _normalize_context_value(getattr(record, "tender_title", "")))
        base_context.setdefault("customer_name", _normalize_context_value(getattr(record, "customer_name", "")))
    elif module_key == "workorders":
        base_context.setdefault("wo_number", _normalize_context_value(getattr(record, "wo_number", "")))
        base_context.setdefault("customer_name", _normalize_context_value(getattr(record, "customer_name", "")))
        base_context.setdefault("progress_percent", _normalize_context_value(getattr(record, "progress_percent", context.get("progress_percent", ""))))
    elif module_key == "emdbg":
        base_context.setdefault("reference_num", _normalize_context_value(getattr(record, "reference_num", "")))
        base_context.setdefault("instrument_type", _normalize_context_value(getattr(record, "instrument_type", "")))
        base_context.setdefault("amount", _normalize_context_value(getattr(record, "amount", "")))
        base_context.setdefault("expiry_date", _normalize_context_value(getattr(record, "expiry_date", "")))
        if getattr(record, "expiry_date", None):
            base_context.setdefault("days_to_expiry", (record.expiry_date - today_ist()).days)
    elif module_key == "customers":
        base_context.setdefault("customer_name", _normalize_context_value(getattr(record, "customer_name", "")))
        base_context.setdefault("account_status", _normalize_context_value(getattr(record, "account_status", "")))
        base_context.setdefault("account_potential", _normalize_context_value(getattr(record, "account_potential", "")))
        base_context.setdefault("potential_value", _normalize_context_value(getattr(record, "potential_value", "")))

    base_context.update(context)
    _inject_display_overrides(db, base_context)
    return base_context


def _get_template_map(db: Session, definition_id: int) -> dict[str, NotificationTemplate]:
    rows = (
        db.query(NotificationTemplate)
        .filter(
            NotificationTemplate.event_definition_id == definition_id,
            NotificationTemplate.is_active == True,
        )
        .all()
    )
    return {row.channel: row for row in rows}


def _reserve_delivery_log(
    db: Session,
    *,
    definition_id: Optional[int],
    module_key: str,
    record_id: Optional[int],
    recipient_user_id: Optional[int],
    recipient_email: Optional[str],
    resolver_key: Optional[str],
    recipient_kind: Optional[str],
    recipient_source: Optional[str],
    channel: str,
    dedupe_key: Optional[str],
) -> tuple[Optional[NotificationDeliveryLog], bool]:
    if dedupe_key:
        try:
            with db.begin_nested():
                log = NotificationDeliveryLog(
                    event_definition_id=definition_id,
                    module_key=module_key,
                    record_id=record_id,
                    recipient_user_id=recipient_user_id,
                    recipient_email=recipient_email,
                    resolver_key=resolver_key,
                    recipient_kind=recipient_kind,
                    recipient_source=recipient_source,
                    channel=channel,
                    status="pending",
                    dedupe_key=dedupe_key,
                    sent_at=now_ist(),
                )
                db.add(log)
                db.flush()
            return log, False
        except IntegrityError:
            return None, True

    log = NotificationDeliveryLog(
        event_definition_id=definition_id,
        module_key=module_key,
        record_id=record_id,
        recipient_user_id=recipient_user_id,
        recipient_email=recipient_email,
        resolver_key=resolver_key,
        recipient_kind=recipient_kind,
        recipient_source=recipient_source,
        channel=channel,
        status="pending",
        dedupe_key=None,
        sent_at=now_ist(),
    )
    db.add(log)
    db.flush()
    return log, False


def _dispatch_notification(
    db: Session,
    *,
    definition: NotificationEventDefinition,
    rule: NotificationRule,
    module_key: str,
    record_id: Optional[int],
    actor_user_id: Optional[int],
    recipient: dict[str, Any],
    channel: str,
    templates: dict[str, NotificationTemplate],
    base_context: dict[str, Any],
    skip_actor: bool,
    dedupe_key: Optional[str],
) -> dict[str, Any]:
    user = recipient.get("user")
    user_id = int(recipient.get("user_id") or 0) or None
    recipient_email = _normalize_email(recipient.get("email") or getattr(user, "email", None)) or None
    resolver_key = str(recipient.get("resolver_key") or serialize_notification_rule_resolver_key(rule) or "").strip() or None
    recipient_kind = str(recipient.get("type") or "").strip() or None
    recipient_source = str(recipient.get("source") or "rule_engine").strip() or None

    if skip_actor and actor_user_id and user_id and int(actor_user_id) == user_id:
        return {"status": "skipped", "channel": channel}

    if channel == CHANNEL_IN_APP and not user_id:
        return {"status": "skipped", "channel": channel}
    if channel == CHANNEL_EMAIL and not recipient_email:
        return {"status": "skipped", "channel": channel}

    reservation_key = None
    if dedupe_key:
        target_key = f"user:{user_id}" if user_id else f"email:{recipient_email.lower()}"
        reservation_key = f"{dedupe_key}:{channel}:{target_key}"

    log_row, is_duplicate = _reserve_delivery_log(
        db,
        definition_id=definition.id,
        module_key=module_key,
        record_id=record_id,
        recipient_user_id=user_id,
        recipient_email=recipient_email,
        resolver_key=resolver_key,
        recipient_kind=recipient_kind,
        recipient_source=recipient_source,
        channel=channel,
        dedupe_key=reservation_key,
    )
    if is_duplicate:
        return {"status": "duplicate", "channel": channel}

    channel_template = templates.get(channel) or templates.get(CHANNEL_EMAIL) or templates.get(CHANNEL_IN_APP)
    recipient_context = dict(base_context)
    recipient_context["recipient_name"] = getattr(user, "full_name", "") if user else ""
    recipient_context["recipient_email"] = recipient_email or ""
    raw_action_url = _render_template(getattr(channel_template, "action_url_template", None), recipient_context) or str(recipient_context.get("action_url") or "")
    action_url = _build_absolute_action_url(raw_action_url)
    recipient_context["action_url"] = action_url

    subject = _render_template(getattr(channel_template, "subject_template", None), recipient_context) or str(recipient_context.get("title_hint") or definition.label)
    summary_text = _render_template(getattr(channel_template, "body_template", None), recipient_context) or str(recipient_context.get("message_hint") or "")
    body = summary_text
    html_body = _render_template(getattr(channel_template, "html_template", None), recipient_context)
    if channel == CHANNEL_EMAIL:
        body = _build_notification_email_text(
            module_key=module_key,
            definition=definition,
            summary_text=summary_text,
            context=recipient_context,
            action_url=action_url,
        )
        html_body = _build_notification_email_html(
            subject=subject,
            module_key=module_key,
            definition=definition,
            summary_text=summary_text,
            context=recipient_context,
            action_url=action_url,
        )

    category = definition.category

    try:
        if channel == CHANNEL_IN_APP:
            upsert_notification(
                db,
                user_id=user_id,
                title=subject,
                message=body,
                module=module_key,
                record_id=record_id,
                action=definition.default_action or f"{module_key}_{definition.event_key}"[:50],
                category=category,
                send_email=False,
            )
            if log_row:
                log_row.status = "sent"
            return {"status": "sent", "channel": channel}

        if user_id:
            sent = send_email_to_user(
                db,
                user_id=user_id,
                subject=subject,
                text_body=body,
                html_body=html_body,
                category=category,
            )
        else:
            sent = _send_email_to_address(
                db,
                recipient_email or "",
                subject=subject,
                text_body=body,
                html_body=html_body,
                category=category,
            )

        if log_row:
            log_row.status = "sent" if sent else "failed"
            if not sent:
                log_row.error_message = "Email dispatch failed or is disabled"
        return {"status": "sent" if sent else "failed", "channel": channel}
    except Exception as exc:
        if log_row:
            log_row.status = "failed"
            log_row.error_message = str(exc)
        logger.warning(
            "dynamic notification dispatch failed: module=%s event=%s record=%s user=%s channel=%s error=%s",
            module_key,
            definition.event_key,
            record_id,
            user_id,
            channel,
            exc,
        )
        return {"status": "failed", "channel": channel, "error": str(exc)}


def emit_notification_event(
    db: Session,
    *,
    module_key: str,
    event_key: str,
    record_id: Optional[int],
    actor_user_id: Optional[int] = None,
    context: Optional[dict[str, Any]] = None,
    skip_actor: bool = False,
) -> dict[str, Any]:
    payload = dict(context or {})
    normalized_module_key = normalize_notification_module_key(module_key)
    definition = resolve_event_definition(db, normalized_module_key, event_key)
    if not definition or not definition.is_active:
        return {"event_found": False, "sent": 0, "failed": 0, "skipped": 0, "duplicates": 0}

    record = _load_record(db, normalized_module_key, record_id)
    templates = _get_template_map(db, definition.id)
    rules = (
        db.query(NotificationRule)
        .filter(
            NotificationRule.event_definition_id == definition.id,
            NotificationRule.is_active == True,
        )
        .order_by(NotificationRule.sort_order.asc(), NotificationRule.id.asc())
        .all()
    )

    if not rules:
        return {"event_found": True, "sent": 0, "failed": 0, "skipped": 0, "duplicates": 0}

    base_context = _build_common_context(
        db,
        module_key=normalized_module_key,
        definition=definition,
        record=record,
        record_id=record_id,
        actor_user_id=actor_user_id,
        context=payload,
    )

    counts = {"sent": 0, "failed": 0, "skipped": 0, "duplicates": 0}
    seen_targets: set[tuple[str, int | str]] = set()
    event_dedupe_key = str(payload.get("dedupe_key") or "").strip() or None

    for rule in rules:
        if not _condition_matches(rule, record, base_context):
            continue

        recipients = _resolve_recipients(
            db,
            rule=rule,
            module_key=module_key,
            record=record,
            context=base_context,
        )
        for recipient in recipients:
            user_id = int(recipient.get("user_id") or 0)
            recipient_email = _normalize_email(recipient.get("email"))
            recipient_key = user_id if user_id else recipient_email
            if not recipient_key:
                counts["skipped"] += 1
                continue

            for channel in _recipient_delivery_channels(recipient, rule.channel):
                dispatch_key = (channel, recipient_key)
                if dispatch_key in seen_targets:
                    counts["duplicates"] += 1
                    continue

                result = _dispatch_notification(
                    db,
                    definition=definition,
                    rule=rule,
                    module_key=normalized_module_key,
                    record_id=record_id,
                    actor_user_id=actor_user_id,
                    recipient=recipient,
                    channel=channel,
                    templates=templates,
                    base_context=base_context,
                    skip_actor=skip_actor,
                    dedupe_key=event_dedupe_key,
                )
                counts[result["status"]] = counts.get(result["status"], 0) + 1
                if result["status"] != "skipped":
                    seen_targets.add(dispatch_key)

    return {"event_found": True, **counts}


def emit_due_emdbg_expiry_events_for_db(db: Session) -> dict[str, int]:
    today = today_ist()
    rows = (
        db.query(EMDBG)
        .filter(
            EMDBG.expiry_date.isnot(None),
            EMDBG.status.notin_(("Released", "Encashed", "Cancelled")),
        )
        .all()
    )

    emitted = {
        "expiry_warning_30d": 0,
        "expiry_warning_7d": 0,
        "expired": 0,
    }

    for row in rows:
        if not row.expiry_date:
            continue
        days_to_expiry = (row.expiry_date - today).days
        base_context = {
            "days_to_expiry": days_to_expiry,
            "status": getattr(row, "status", ""),
            "record_ref": row.reference_num,
        }

        if 0 <= days_to_expiry <= 30:
            result = emit_notification_event(
                db,
                module_key="emdbg",
                event_key="expiry_warning_30d",
                record_id=row.id,
                context={
                    **base_context,
                    "dedupe_key": f"emdbg:{row.id}:expiry_warning_30d:{row.expiry_date.isoformat()}",
                },
            )
            emitted["expiry_warning_30d"] += int(result.get("sent", 0) > 0)

        if 0 <= days_to_expiry <= 7:
            result = emit_notification_event(
                db,
                module_key="emdbg",
                event_key="expiry_warning_7d",
                record_id=row.id,
                context={
                    **base_context,
                    "dedupe_key": f"emdbg:{row.id}:expiry_warning_7d:{row.expiry_date.isoformat()}",
                },
            )
            emitted["expiry_warning_7d"] += int(result.get("sent", 0) > 0)

        if days_to_expiry < 0:
            result = emit_notification_event(
                db,
                module_key="emdbg",
                event_key="expired",
                record_id=row.id,
                context={
                    **base_context,
                    "dedupe_key": f"emdbg:{row.id}:expired:{row.expiry_date.isoformat()}",
                },
            )
            emitted["expired"] += int(result.get("sent", 0) > 0)

    return emitted


def emit_due_workorder_delay_events_for_db(db: Session) -> dict[str, int]:
    emitted = {"delayed_overdue": 0}
    today = today_ist()
    rows = (
        db.query(WorkOrder)
        .filter(WorkOrder.status.notin_(("Completed", "Closed", "Cancelled")))
        .all()
    )

    for row in rows:
        due_date = getattr(row, "completion_date", None) or getattr(row, "delivery_date", None) or getattr(row, "installation_date", None)
        if not due_date or due_date >= today:
            continue

        result = emit_notification_event(
            db,
            module_key="workorders",
            event_key="delayed_overdue",
            record_id=row.id,
            context={
                "status": getattr(row, "status", ""),
                "record_ref": getattr(row, "wo_number", ""),
                "dedupe_key": f"workorders:{row.id}:delayed_overdue:{due_date.isoformat()}",
            },
        )
        emitted["delayed_overdue"] += int(result.get("sent", 0) > 0)

    return emitted


def run_due_notification_maintenance_for_all_tenants() -> dict[str, dict[str, int]]:
    summary: dict[str, dict[str, int]] = {}
    master_db = MasterSessionLocal()
    try:
        tenants = master_db.query(Tenant).filter(Tenant.status.in_(["active", "trial"])).all()
        for tenant in tenants:
            tenant_db = get_tenant_session_by_db_name(tenant.db_name, cache_key=tenant.slug)
            try:
                tenant_db.info["tenant_slug"] = tenant.slug
                ensure_notification_catalog_seeded(tenant_db)
                summary[tenant.slug] = {
                    **emit_due_emdbg_expiry_events_for_db(tenant_db),
                    **emit_due_workorder_delay_events_for_db(tenant_db),
                }
                tenant_db.commit()
            except Exception as exc:
                tenant_db.rollback()
                logger.warning("emdbg expiry notification run failed for tenant=%s: %s", tenant.slug, exc)
            finally:
                tenant_db.close()
    finally:
        master_db.close()
    return summary


def run_due_emdbg_expiry_events_for_all_tenants() -> dict[str, dict[str, int]]:
    return run_due_notification_maintenance_for_all_tenants()

