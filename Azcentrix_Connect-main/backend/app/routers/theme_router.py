"""
Tenant theme and settings router.

Mounted at /api/v1/settings.
"""
import json
import logging
import re
from datetime import datetime
from app.core.timezone import now_ist, today_ist
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, RootModel
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.core.config import settings
from app.core import validators as V
from app.database import get_master_db_dep
from app.core.logging import log_module_action
from app.dependencies import get_current_user, get_request_ip, get_tenant_db
from app.models.all_models import (
    DashboardPreference,
    NotificationEventDefinition,
    NotificationRule,
    NotificationTemplate,
    Setting as LegacySetting,
    TenantAddress,
    TenantSetting,
    User,
)
from app.models.tenant import Tenant
from app.services.dynamic_notification_service import (
    ROLE_ALIASES,
    SUPPORTED_RECIPIENT_TYPES,
    ensure_notification_catalog_seeded,
    get_default_linked_resolvers,
    get_supported_recipient_resolver_keys,
    list_supported_notification_modules,
    map_ui_to_resolver_keys,
    normalize_notification_module_key,
    serialize_notification_rule_resolver_key,
)
from app.services.cache_service import (
    CACHE_TTL_SECONDS,
    cache_get_json,
    cache_set_json,
    invalidate_theme_cache,
    tenant_slug_from_db,
    theme_cache_key,
)
from app.services.lead_notification_service import LEAD_NOTIFICATION_SETTING_DEFAULTS
from app.services.storage_usage_service import (
    ensure_tenant_storage_available,
    refresh_tenant_storage_usage_for_slug,
)

logger = logging.getLogger(__name__)
router = APIRouter()


DEFAULTS: Dict[str, Dict[str, Any]] = {
    "theme_primary": {"value": "#0B1F3A", "type": "color"},
    "theme_secondary": {"value": "#1E3A5F", "type": "color"},
    "theme_accent": {"value": "#3B82F6", "type": "color"},
    "theme_sidebar": {"value": "#0F172A", "type": "color"},
    "theme_success": {"value": "#059669", "type": "color"},
    "theme_warning": {"value": "#D97706", "type": "color"},
    "theme_danger": {"value": "#DC2626", "type": "color"},
    "theme_font": {"value": "Inter", "type": "string"},
    "theme_font_size": {"value": "16", "type": "number"},
    "company_name": {"value": "", "type": "string"},
    "theme_logo": {"value": "", "type": "string"},
    "date_format": {"value": "DD-MM-YYYY", "type": "string"},
    "currency": {"value": "INR", "type": "string"},
    "fiscal_year_start": {"value": "04", "type": "string"},
    "email_notifications": {"value": "true", "type": "bool"},
    "approval_email_notifications": {"value": "true", "type": "bool"},
    "alert_email_notifications": {"value": "true", "type": "bool"},
    "event_email_notifications": {"value": "true", "type": "bool"},
    "tender_approval_required": {"value": "true", "type": "bool"},
    "travel_approval_required": {"value": "true", "type": "bool"},
    "travel_auto_approve_minutes": {"value": "0", "type": "number"},
    "travel_request_advance_days": {"value": "3", "type": "number"},
    "tada_approval_required": {"value": "true", "type": "bool"},
    "tada_accounts_approval": {"value": "true", "type": "bool"},
    "lead_auto_assign": {"value": "false", "type": "bool"},
    **LEAD_NOTIFICATION_SETTING_DEFAULTS,
}

REQUEST_KEY_ALIASES = {
    "primary_color": "theme_primary",
    "secondary_color": "theme_secondary",
    "accent_color": "theme_accent",
    "sidebar_color": "theme_sidebar",
    "success_color": "theme_success",
    "warning_color": "theme_warning",
    "danger_color": "theme_danger",
    "font_family": "theme_font",
    "font_size": "theme_font_size",
    "company_logo": "theme_logo",
    "logo_url": "theme_logo",
    "from_email": "mail",
    "company_email": "company_mail",
    "company_address": "address",
    "company_street_address": "street_address",
}

LEGACY_STORAGE_KEYS = {
    "theme_primary": "primary_color",
    "theme_secondary": "secondary_color",
    "theme_accent": "accent_color",
    "theme_sidebar": "sidebar_color",
    "theme_success": "success_color",
    "theme_warning": "warning_color",
    "theme_danger": "danger_color",
    "theme_font": "font_family",
    "theme_logo": "company_logo",
}

LOGO_SETTING_KEY = "theme_logo"
LETTER_PAD_SEAL_SETTING_KEY = "letter_pad_seal"
LOGO_VERSION_KEY = "theme_logo_version"
SMTP_HOST_KEY = "smtp_host"
SMTP_PORT_KEY = "smtp_port"
SMTP_USER_KEY = "smtp_user"
SMTP_PASSWORD_KEY = "smtp_password"
SMTP_SECURITY_KEY = "smtp_security"
MAIL_KEY = "mail"
COMPANY_MAIL_KEY = "company_mail"
ADDRESS_KEY = "address"
STREET_ADDRESS_KEY = "street_address"
PINCODE_KEY = "pincode"
COUNTRY_KEY = "country"
STATE_KEY = "state"
CITY_DISTRICT_KEY = "city_district"
AREA_LOCALITY_KEY = "area_locality"
FORGOT_PASSWORD_ENABLED_KEY = "forgot_password_enabled"
FORCE_PASSWORD_CHANGE_ON_FIRST_LOGIN_KEY = "force_password_change_on_first_login"
NEW_DEVICE_LOGIN_ALERT_ENABLED_KEY = "new_device_login_alert_enabled"
OTP_MODE_KEY = "otp_mode"
CAPTCHA_MODE_KEY = "captcha_mode"
SMTP_SECURITY_TLS = "TLS"
SMTP_SECURITY_SSL = "SSL"
MAX_USERS_KEY = "max_users"
ACTIVE_USER_COUNT_KEY = "active_user_count"
READ_ONLY_KEYS = {LOGO_VERSION_KEY, MAX_USERS_KEY, ACTIVE_USER_COUNT_KEY}
ALLOWED_LOGO_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}
CONTENT_TYPE_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
}
INTERNAL_SETTING_PREFIX = "_internal_"
COMPANY_ADDRESS_SETTING_KEYS = (
    ADDRESS_KEY,
    STREET_ADDRESS_KEY,
    PINCODE_KEY,
    COUNTRY_KEY,
    STATE_KEY,
    CITY_DISTRICT_KEY,
    AREA_LOCALITY_KEY,
)


class SettingValueResponse(BaseModel):
    value: str
    type: str


class ThemeSettingsResponse(BaseModel):
    theme_primary: str
    theme_secondary: str
    theme_accent: str
    theme_sidebar: str
    theme_success: str
    theme_warning: str
    theme_danger: str
    theme_font: str
    theme_font_size: str
    company_name: str
    theme_logo: str
    theme_logo_version: str
    company_logo: str
    primary_color: str
    secondary_color: str
    accent_color: str
    sidebar_color: str
    success_color: str
    warning_color: str
    danger_color: str
    font_family: str
    font_size: str
    logo_url: str
    forgot_password_enabled: bool


class BulkSettingsPayload(RootModel[Dict[str, Any]]):
    pass


class SaveSettingsResponse(BaseModel):
    status: str
    count: int


class SingleSettingUpdate(BaseModel):
    value: Any


class SingleSettingResponse(BaseModel):
    key: str
    value: str
    type: str


class ThemeLogoResponse(BaseModel):
    theme_logo: str
    theme_logo_version: str
    company_logo: str
    logo_url: str


class DeleteThemeLogoResponse(BaseModel):
    status: str
    deleted_file: bool


class CompanyAddressItem(BaseModel):
    id: Optional[int] = None
    label: str = ""
    street_address: Optional[str] = None
    pincode: Optional[str] = None
    area_locality: Optional[str] = None
    city_district: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = "India"
    is_primary: bool = False
    is_active: bool = True
    sort_order: int = 0


class CompanyAddressListResponse(BaseModel):
    addresses: List[CompanyAddressItem]


class CompanyAddressUpdatePayload(BaseModel):
    addresses: List[CompanyAddressItem] = []


class WidgetConfig(BaseModel):
    id: str
    visible: bool = True
    order: int


class DashboardPreferenceUpdate(BaseModel):
    widgets: List[WidgetConfig]


NOTIFICATION_RECIPIENT_LABELS: Dict[str, str] = {
    "assignee": "Assignee",
    "creator": "Creator",
    "requester": "Requester",
    "approver": "Approver",
    "manager": "Manager",
    "role:admin": "Admins",
    "role:ceo": "CEO",
    "role:accounts": "Accounts",
    "customer_owner": "Customer Owner",
    "customer_primary_contact": "Customer Primary Contact",
    "customer_all_contacts": "Customer All Contacts",
}
NOTIFICATION_UI_RECIPIENT_COLUMNS = (
    {"key": "linked_users", "label": "Linked Users"},
    {"key": "manager", "label": "Manager"},
    {"key": "admin", "label": "Admin"},
    {"key": "ceo", "label": "CEO"},
)


class NotificationOptionItem(BaseModel):
    key: str
    label: str


class NotificationEventItem(BaseModel):
    id: int
    module_key: str
    module_label: str
    event_key: str
    label: str
    category: str
    description: Optional[str] = None
    default_action: Optional[str] = None
    is_system: bool
    is_active: bool


class NotificationEventsResponse(BaseModel):
    modules: List[NotificationOptionItem]
    recipient_types: List[NotificationOptionItem]
    role_options: List[NotificationOptionItem]
    ui_recipient_columns: List[NotificationOptionItem]
    events: List[NotificationEventItem]


class NotificationRuleItem(BaseModel):
    event_definition_id: int
    module_key: Optional[str] = None
    event_key: Optional[str] = None
    recipients: List[str] = []
    available_linked_resolvers: List[str] = []
    linked_users: bool = False
    manager: bool = False
    admin: bool = False
    ceo: bool = False
    condition_json: Optional[Dict[str, Any]] = None
    is_active: bool = True


class NotificationRuleListResponse(BaseModel):
    rules: List[NotificationRuleItem]


class NotificationRuleUpdatePayload(BaseModel):
    replace_event_definition_ids: List[int] = []
    rules: List[NotificationRuleItem] = []


class NotificationTemplateItem(BaseModel):
    event_definition_id: int
    module_key: Optional[str] = None
    event_key: Optional[str] = None
    subject_template: Optional[str] = None
    body_template: Optional[str] = None
    html_template: Optional[str] = None
    action_url_template: Optional[str] = None
    is_active: bool = True


class NotificationTemplateListResponse(BaseModel):
    templates: List[NotificationTemplateItem]


class NotificationTemplateUpdatePayload(BaseModel):
    replace_event_definition_ids: List[int] = []
    templates: List[NotificationTemplateItem] = []


class NotificationRecipientTypeItem(BaseModel):
    key: str
    label: str
    delivery: str


class NotificationRecipientTypesResponse(BaseModel):
    module_key: str
    recipient_types: List[NotificationRecipientTypeItem]
    ui_recipient_columns: List[NotificationOptionItem]


def _coerce_notification_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    normalized = str(value).strip().lower()
    if normalized in {"true", "1", "yes", "on"}:
        return True
    if normalized in {"false", "0", "no", "off", ""}:
        return False
    return default


def _coerce_notification_optional_str(value: Any) -> Optional[str]:
    normalized = str(value or "").strip()
    return normalized or None


def _coerce_notification_required_int(value: Any, field_name: str) -> int:
    try:
        if value in (None, ""):
            raise ValueError
        return int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field_name} must be an integer") from None


def _coerce_notification_str_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        normalized = value.strip()
        if not normalized:
            return []
        if normalized.startswith("[") and normalized.endswith("]"):
            try:
                parsed = json.loads(normalized)
            except Exception:
                parsed = None
            if isinstance(parsed, list):
                return _coerce_notification_str_list(parsed)
        return [item.strip() for item in normalized.split(",") if item.strip()]
    if isinstance(value, (list, tuple, set)):
        items: List[str] = []
        for item in value:
            normalized = str(item or "").strip()
            if normalized:
                items.append(normalized)
        return items
    normalized = str(value).strip()
    return [normalized] if normalized else []


def _coerce_condition_json(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        normalized = value.strip()
        if not normalized:
            return None
        try:
            parsed = json.loads(normalized)
        except Exception:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _normalize_notification_rule_payload(payload: Any) -> NotificationRuleUpdatePayload:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid notification rule payload")

    replace_event_definition_ids = {
        _coerce_notification_required_int(event_definition_id, "replace_event_definition_ids[]")
        for event_definition_id in (payload.get("replace_event_definition_ids") or [])
        if event_definition_id not in (None, "")
    }
    normalized_by_event: Dict[int, Dict[str, Any]] = {}

    for raw_item in (payload.get("rules") or []):
        if not isinstance(raw_item, dict):
            continue

        event_definition_id = _coerce_notification_required_int(
            raw_item.get("event_definition_id"),
            "rules[].event_definition_id",
        )
        replace_event_definition_ids.add(event_definition_id)
        current = normalized_by_event.setdefault(
            event_definition_id,
            {
                "event_definition_id": event_definition_id,
                "module_key": None,
                "event_key": None,
                "recipients": [],
                "available_linked_resolvers": [],
                "linked_users": False,
                "manager": False,
                "admin": False,
                "ceo": False,
                "condition_json": None,
                "is_active": False,
            },
        )

        module_key = _coerce_notification_optional_str(raw_item.get("module_key"))
        event_key = _coerce_notification_optional_str(raw_item.get("event_key"))
        if module_key:
            current["module_key"] = module_key
        if event_key:
            current["event_key"] = event_key

        recipient_values = {
            str(recipient).strip().lower()
            for recipient in _coerce_notification_str_list(raw_item.get("recipients"))
            if str(recipient).strip()
        }
        legacy_recipient_type = str(raw_item.get("recipient_type") or "").strip().lower()
        if legacy_recipient_type:
            if legacy_recipient_type == "role":
                legacy_role = str(raw_item.get("recipient_role") or "").strip().lower()
                if legacy_role:
                    recipient_values.add(f"role:{legacy_role}")
            else:
                recipient_values.add(legacy_recipient_type)

        for recipient_type in _coerce_notification_str_list(raw_item.get("recipient_types")):
            normalized_recipient_type = str(recipient_type).strip().lower()
            if normalized_recipient_type:
                recipient_values.add(normalized_recipient_type)
        for role_key in _coerce_notification_str_list(raw_item.get("role_keys")):
            normalized_role_key = str(role_key).strip().lower()
            if normalized_role_key:
                recipient_values.add(f"role:{normalized_role_key}")

        current["recipients"] = sorted(dict.fromkeys([*current["recipients"], *recipient_values]))
        current["available_linked_resolvers"] = sorted(
            dict.fromkeys(
                [
                    *current["available_linked_resolvers"],
                    *[
                        str(recipient).strip().lower()
                        for recipient in _coerce_notification_str_list(raw_item.get("available_linked_resolvers"))
                        if str(recipient).strip()
                    ],
                ]
            )
        )

        current["linked_users"] = current["linked_users"] or _coerce_notification_bool(raw_item.get("linked_users"))
        current["manager"] = current["manager"] or _coerce_notification_bool(raw_item.get("manager")) or ("manager" in recipient_values)
        current["admin"] = current["admin"] or _coerce_notification_bool(raw_item.get("admin")) or ("role:admin" in recipient_values)
        current["ceo"] = current["ceo"] or _coerce_notification_bool(raw_item.get("ceo")) or ("role:ceo" in recipient_values)
        current["is_active"] = current["is_active"] or _coerce_notification_bool(raw_item.get("is_active"), True)

        condition_json = _coerce_condition_json(raw_item.get("condition_json"))
        if condition_json is not None or current["condition_json"] is None:
            current["condition_json"] = condition_json

    rules = [NotificationRuleItem(**item) for _, item in sorted(normalized_by_event.items())]
    return NotificationRuleUpdatePayload(
        replace_event_definition_ids=sorted(replace_event_definition_ids),
        rules=rules,
    )


def _normalize_notification_template_payload(payload: Any) -> NotificationTemplateUpdatePayload:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid notification template payload")

    replace_event_definition_ids = {
        _coerce_notification_required_int(event_definition_id, "replace_event_definition_ids[]")
        for event_definition_id in (payload.get("replace_event_definition_ids") or [])
        if event_definition_id not in (None, "")
    }
    normalized_by_event: Dict[int, Dict[str, Any]] = {}

    for raw_item in (payload.get("templates") or []):
        if not isinstance(raw_item, dict):
            continue

        event_definition_id = _coerce_notification_required_int(
            raw_item.get("event_definition_id"),
            "templates[].event_definition_id",
        )
        replace_event_definition_ids.add(event_definition_id)
        current = normalized_by_event.setdefault(
            event_definition_id,
            {
                "event_definition_id": event_definition_id,
                "module_key": None,
                "event_key": None,
                "subject_template": None,
                "body_template": None,
                "html_template": None,
                "action_url_template": None,
                "is_active": False,
            },
        )

        module_key = _coerce_notification_optional_str(raw_item.get("module_key"))
        event_key = _coerce_notification_optional_str(raw_item.get("event_key"))
        if module_key:
            current["module_key"] = module_key
        if event_key:
            current["event_key"] = event_key

        channel = str(raw_item.get("channel") or "").strip().lower()
        preferred = channel == "email"
        for field_name in ("subject_template", "body_template", "html_template", "action_url_template"):
            field_value = _coerce_notification_optional_str(raw_item.get(field_name))
            if preferred or current[field_name] in (None, ""):
                current[field_name] = field_value

        current["is_active"] = current["is_active"] or _coerce_notification_bool(raw_item.get("is_active"), True)

    templates = [NotificationTemplateItem(**item) for _, item in sorted(normalized_by_event.items())]
    return NotificationTemplateUpdatePayload(
        replace_event_definition_ids=sorted(replace_event_definition_ids),
        templates=templates,
    )


def _notification_fallback_label(value: str) -> str:
    return value.replace("_", " ").title()


def _notification_module_label(module_key: str) -> str:
    return next(
        (item["label"] for item in list_supported_notification_modules() if item["key"] == module_key),
        _notification_fallback_label(module_key),
    )


def _serialize_notification_event(row: NotificationEventDefinition) -> Dict[str, Any]:
    return {
        "id": row.id,
        "module_key": row.module_key,
        "module_label": _notification_module_label(row.module_key),
        "event_key": row.event_key,
        "label": row.label,
        "category": row.category,
        "description": row.description,
        "default_action": row.default_action,
        "is_system": bool(row.is_system),
        "is_active": bool(row.is_active),
    }


def _build_default_notification_rule_item(definition: NotificationEventDefinition) -> Dict[str, Any]:
    linked_resolvers = get_default_linked_resolvers(definition.module_key, definition.event_key)
    return {
        "event_definition_id": definition.id,
        "module_key": definition.module_key,
        "event_key": definition.event_key,
        "recipients": [],
        "available_linked_resolvers": linked_resolvers,
        "linked_users": False,
        "manager": False,
        "admin": False,
        "ceo": False,
        "condition_json": None,
        "is_active": False,
    }


def _serialize_notification_rule_rows(
    definition: NotificationEventDefinition,
    rows: List[NotificationRule],
) -> Dict[str, Any]:
    item = _build_default_notification_rule_item(definition)
    source_rows = [row for row in rows if bool(row.is_active)] or rows
    allowed_resolvers = set(get_supported_recipient_resolver_keys(definition.module_key))
    recipients: List[str] = []

    for row in source_rows:
        resolver_key = serialize_notification_rule_resolver_key(row)
        if resolver_key and resolver_key in allowed_resolvers:
            recipients.append(resolver_key)
        if item["condition_json"] is None and row.condition_json is not None:
            item["condition_json"] = row.condition_json

    normalized_recipients = sorted(dict.fromkeys(recipients))
    linked_resolvers = item["available_linked_resolvers"]
    item["recipients"] = normalized_recipients
    item["linked_users"] = bool(linked_resolvers) and set(linked_resolvers).issubset(set(normalized_recipients))
    item["manager"] = "manager" in normalized_recipients
    item["admin"] = "role:admin" in normalized_recipients
    item["ceo"] = "role:ceo" in normalized_recipients
    item["is_active"] = any(bool(row.is_active) for row in rows)
    return item


def _build_default_notification_template_item(definition: NotificationEventDefinition) -> Dict[str, Any]:
    return {
        "event_definition_id": definition.id,
        "module_key": definition.module_key,
        "event_key": definition.event_key,
        "subject_template": None,
        "body_template": None,
        "html_template": None,
        "action_url_template": None,
        "is_active": True,
    }


def _serialize_notification_template_rows(
    definition: NotificationEventDefinition,
    rows: List[NotificationTemplate],
) -> Dict[str, Any]:
    item = _build_default_notification_template_item(definition)
    if not rows:
        return item

    source_rows = [row for row in rows if bool(row.is_active)] or rows
    preferred_row = next((row for row in source_rows if row.channel == "email"), source_rows[0])
    return {
        "event_definition_id": definition.id,
        "module_key": definition.module_key,
        "event_key": definition.event_key,
        "subject_template": preferred_row.subject_template,
        "body_template": preferred_row.body_template,
        "html_template": preferred_row.html_template,
        "action_url_template": preferred_row.action_url_template,
        "is_active": any(bool(row.is_active) for row in rows),
    }


def _load_notification_definition_map(
    db: Session,
    event_definition_ids: Optional[Iterable[int]] = None,
) -> Dict[int, NotificationEventDefinition]:
    query = db.query(NotificationEventDefinition)
    if event_definition_ids is not None:
        safe_ids = sorted({int(event_definition_id) for event_definition_id in event_definition_ids if event_definition_id})
        if not safe_ids:
            return {}
        query = query.filter(NotificationEventDefinition.id.in_(safe_ids))
    return {row.id: row for row in query.all()}


def _validate_notification_rule_item(
    item: NotificationRuleItem,
    definition_map: Dict[int, NotificationEventDefinition],
) -> None:
    if item.event_definition_id not in definition_map:
        raise HTTPException(status_code=400, detail=f"Unknown notification event definition: {item.event_definition_id}")
    invalid_flags = [
        flag_name
        for flag_name in ("linked_users", "manager", "admin", "ceo")
        if not isinstance(getattr(item, flag_name), bool)
    ]
    if invalid_flags:
        raise HTTPException(status_code=400, detail=f"Invalid notification UI flags: {invalid_flags}")

    definition = definition_map[item.event_definition_id]
    allowed_recipients = set(get_supported_recipient_resolver_keys(definition.module_key))
    invalid_recipients = sorted(
        {
            str(recipient).strip().lower()
            for recipient in (item.recipients or [])
            if str(recipient).strip() and str(recipient).strip().lower() not in allowed_recipients
        }
    )
    if invalid_recipients:
        raise HTTPException(status_code=400, detail=f"Unsupported notification recipient resolvers: {invalid_recipients}")


def _validate_notification_template_item(
    item: NotificationTemplateItem,
    definition_map: Dict[int, NotificationEventDefinition],
) -> None:
    if item.event_definition_id not in definition_map:
        raise HTTPException(status_code=400, detail=f"Unknown notification event definition: {item.event_definition_id}")


def _build_notification_events_response(db: Session) -> Dict[str, Any]:
    definitions = (
        db.query(NotificationEventDefinition)
        .order_by(
            NotificationEventDefinition.module_key.asc(),
            NotificationEventDefinition.label.asc(),
            NotificationEventDefinition.id.asc(),
        )
        .all()
    )
    return {
        "modules": [
            {"key": item["key"], "label": item["label"]}
            for item in list_supported_notification_modules()
        ],
        "recipient_types": [
            {
                "key": recipient_type,
                "label": NOTIFICATION_RECIPIENT_LABELS.get(recipient_type, _notification_fallback_label(recipient_type)),
            }
            for recipient_type in SUPPORTED_RECIPIENT_TYPES
        ],
        "role_options": [
            {
                "key": role_key,
                "label": NOTIFICATION_RECIPIENT_LABELS.get(f"role:{role_key}", _notification_fallback_label(role_key)),
            }
            for role_key in ROLE_ALIASES.keys()
        ],
        "ui_recipient_columns": [dict(item) for item in NOTIFICATION_UI_RECIPIENT_COLUMNS],
        "events": [_serialize_notification_event(row) for row in definitions],
    }


def _notification_delivery_type(recipient_key: str) -> str:
    if recipient_key in {"customer_primary_contact", "customer_all_contacts"}:
        return "email_only"
    return "in_app_and_email"


def _build_notification_recipient_types_response(module_key: str) -> Dict[str, Any]:
    normalized_module_key = normalize_notification_module_key(module_key)
    return {
        "module_key": normalized_module_key,
        "recipient_types": [
            {
                "key": recipient_key,
                "label": NOTIFICATION_RECIPIENT_LABELS.get(recipient_key, _notification_fallback_label(recipient_key)),
                "delivery": _notification_delivery_type(recipient_key),
            }
            for recipient_key in get_supported_recipient_resolver_keys(normalized_module_key)
        ],
        "ui_recipient_columns": [dict(item) for item in NOTIFICATION_UI_RECIPIENT_COLUMNS],
    }


def _build_notification_rules_response(
    db: Session,
    *,
    module_key: Optional[str] = None,
    event_key: Optional[str] = None,
) -> Dict[str, Any]:
    definitions_query = db.query(NotificationEventDefinition)
    if module_key:
        definitions_query = definitions_query.filter(NotificationEventDefinition.module_key == normalize_notification_module_key(module_key))
    if event_key:
        definitions_query = definitions_query.filter(NotificationEventDefinition.event_key == event_key)
    definitions = (
        definitions_query.order_by(
            NotificationEventDefinition.module_key.asc(),
            NotificationEventDefinition.label.asc(),
            NotificationEventDefinition.id.asc(),
        )
        .all()
    )
    if not definitions:
        return {"rules": []}

    rows = (
        db.query(NotificationRule)
        .filter(NotificationRule.event_definition_id.in_([definition.id for definition in definitions]))
        .all()
    )
    rows_by_event: Dict[int, List[NotificationRule]] = {}
    for row in rows:
        rows_by_event.setdefault(row.event_definition_id, []).append(row)

    return {
        "rules": [
            _serialize_notification_rule_rows(definition, rows_by_event.get(definition.id, []))
            for definition in definitions
        ],
    }


def _build_notification_templates_response(
    db: Session,
    *,
    module_key: Optional[str] = None,
    event_key: Optional[str] = None,
) -> Dict[str, Any]:
    definitions_query = db.query(NotificationEventDefinition)
    if module_key:
        definitions_query = definitions_query.filter(NotificationEventDefinition.module_key == normalize_notification_module_key(module_key))
    if event_key:
        definitions_query = definitions_query.filter(NotificationEventDefinition.event_key == event_key)
    definitions = (
        definitions_query.order_by(
            NotificationEventDefinition.module_key.asc(),
            NotificationEventDefinition.label.asc(),
            NotificationEventDefinition.id.asc(),
        )
        .all()
    )
    if not definitions:
        return {"templates": []}

    rows = (
        db.query(NotificationTemplate)
        .filter(NotificationTemplate.event_definition_id.in_([definition.id for definition in definitions]))
        .order_by(NotificationTemplate.id.asc())
        .all()
    )
    rows_by_event: Dict[int, List[NotificationTemplate]] = {}
    for row in rows:
        rows_by_event.setdefault(row.event_definition_id, []).append(row)

    return {
        "templates": [
            _serialize_notification_template_rows(definition, rows_by_event.get(definition.id, []))
            for definition in definitions
        ],
    }


def _ensure_table(db: Session) -> None:
    try:
        TenantSetting.__table__.create(bind=db.get_bind(), checkfirst=True)
    except Exception:
        pass


def _ensure_company_address_table(db: Session) -> None:
    try:
        TenantAddress.__table__.create(bind=db.get_bind(), checkfirst=True)
    except Exception:
        pass


def _normalize_setting_key(key: str) -> str:
    return REQUEST_KEY_ALIASES.get(key, key)


def _legacy_storage_key(key: str) -> str:
    return LEGACY_STORAGE_KEYS.get(key, key)


def _candidate_setting_keys(key: str) -> set[str]:
    canonical_key = _normalize_setting_key(key)
    candidate_keys = {canonical_key, _legacy_storage_key(canonical_key)}
    candidate_keys.update(
        alias_key
        for alias_key, resolved_key in REQUEST_KEY_ALIASES.items()
        if resolved_key == canonical_key
    )
    return {candidate_key for candidate_key in candidate_keys if candidate_key}


def _candidate_setting_keys_for_many(keys: Iterable[str]) -> set[str]:
    candidate_keys: set[str] = set()
    for key in keys:
        candidate_keys.update(_candidate_setting_keys(key))
    return candidate_keys


def _legacy_setting_type(value_type: str) -> str:
    return {"bool": "boolean"}.get(value_type, value_type)


def _serialize_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    return str(value)


def _clean_nullable_string(value: Any) -> Optional[str]:
    serialized = _serialize_value(value).strip()
    return serialized or None


def _get_stored_setting_value(db: Session, key: str) -> Optional[str]:
    candidate_keys = _candidate_setting_keys(key)

    row = db.query(TenantSetting).filter(TenantSetting.key.in_(candidate_keys)).first()
    if row and row.value is not None:
        return row.value

    try:
        legacy_row = db.query(LegacySetting).filter(LegacySetting.key.in_(candidate_keys)).first()
    except Exception:
        legacy_row = None

    if legacy_row and legacy_row.value is not None:
        return legacy_row.value
    return None


def _infer_category(key: str) -> str:
    if key == LOGO_SETTING_KEY:
        return "company"
    if key.startswith("theme_"):
        return "theme"
    if key.startswith("company_") or key in {"date_format", "currency", "fiscal_year_start"}:
        return "company"
    if key in {
        "email_notifications",
        "approval_email_notifications",
        "alert_email_notifications",
        "event_email_notifications",
        "tender_approval_required",
        "travel_approval_required",
        "travel_auto_approve_minutes",
        "travel_request_advance_days",
        "tada_approval_required",
        "tada_accounts_approval",
        "lead_auto_assign",
    }:
        return "notifications"
    if key.startswith("lead_notify_"):
        return "notifications"
    return "general"


def _infer_label(key: str) -> str:
    return key.replace("_", " ").title()


def _load_legacy_settings(db: Session) -> Dict[str, Dict[str, Any]]:
    try:
        rows = db.query(LegacySetting).all()
    except Exception:
        return {}

    result: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        canonical_key = _normalize_setting_key(row.key)
        result[canonical_key] = {
            "value": row.value or "",
            "type": DEFAULTS.get(canonical_key, {}).get("type", row.type or "string"),
        }
    return result


def _sync_legacy_setting(db: Session, key: str, value: str, value_type: str) -> None:
    legacy_key = _legacy_storage_key(key)
    try:
        row = db.query(LegacySetting).filter(LegacySetting.key == legacy_key).first()
    except Exception:
        return

    if row:
        row.value = value
        row.type = _legacy_setting_type(value_type)
        row.category = row.category or _infer_category(key)
        row.label = row.label or _infer_label(key)
        return

    db.add(LegacySetting(
        key=legacy_key,
        value=value,
        type=_legacy_setting_type(value_type),
        category=_infer_category(key),
        label=_infer_label(key),
    ))


def _get_master_tenant(request: Request, master_db: Session) -> Tenant:
    tenant_slug = getattr(request.state, "tenant_slug", None)
    if not tenant_slug:
        raise HTTPException(status_code=400, detail="Tenant context is required")

    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return tenant


def _get_tenant_smtp_user_value(tenant: Tenant) -> str:
    return (tenant.smtp_user or "").strip()


def _get_tenant_mail_value(tenant: Tenant) -> str:
    return (tenant.from_email or tenant.smtp_user or "").strip()


def _get_tenant_company_mail_value(tenant: Tenant) -> str:
    return (getattr(tenant, "company_mail", None) or "").strip()


def _get_tenant_address_value(tenant: Tenant) -> str:
    return (getattr(tenant, "address", None) or "").strip()


def _get_tenant_street_address_value(tenant: Tenant) -> str:
    return (getattr(tenant, "street_address", None) or "").strip()


def _get_tenant_pincode_value(tenant: Tenant) -> str:
    return (getattr(tenant, "pincode", None) or "").strip()


def _get_tenant_country_value(tenant: Tenant) -> str:
    return (getattr(tenant, "country", None) or "India").strip() or "India"


def _get_tenant_state_value(tenant: Tenant) -> str:
    return (getattr(tenant, "state", None) or "").strip()


def _get_tenant_city_district_value(tenant: Tenant) -> str:
    return (getattr(tenant, "city_district", None) or "").strip()


def _get_tenant_area_locality_value(tenant: Tenant) -> str:
    return (getattr(tenant, "area_locality", None) or "").strip()


def _legacy_tenant_address_payload(tenant: Tenant, db: Session) -> Dict[str, Optional[str]]:
    legacy_address = _clean_nullable_string(_get_stored_setting_value(db, ADDRESS_KEY))
    legacy_street_address = _clean_nullable_string(_get_stored_setting_value(db, STREET_ADDRESS_KEY))
    legacy_pincode = _clean_nullable_string(_get_stored_setting_value(db, PINCODE_KEY))
    legacy_country = _clean_nullable_string(_get_stored_setting_value(db, COUNTRY_KEY))
    legacy_state = _clean_nullable_string(_get_stored_setting_value(db, STATE_KEY))
    legacy_city_district = _clean_nullable_string(_get_stored_setting_value(db, CITY_DISTRICT_KEY))
    legacy_area_locality = _clean_nullable_string(_get_stored_setting_value(db, AREA_LOCALITY_KEY))

    return {
        "street_address": (
            _clean_nullable_string(getattr(tenant, "street_address", None))
            or _clean_nullable_string(getattr(tenant, "address", None))
            or legacy_street_address
            or legacy_address
        ),
        "pincode": _clean_nullable_string(getattr(tenant, "pincode", None)) or legacy_pincode,
        "country": (_clean_nullable_string(getattr(tenant, "country", None)) or legacy_country or "India"),
        "state": _clean_nullable_string(getattr(tenant, "state", None)) or legacy_state,
        "city_district": _clean_nullable_string(getattr(tenant, "city_district", None)) or legacy_city_district,
        "area_locality": _clean_nullable_string(getattr(tenant, "area_locality", None)) or legacy_area_locality,
    }


def _company_address_has_content(raw_address: Dict[str, Optional[str]]) -> bool:
    return any(
        (raw_address.get(key) or "").strip()
        for key in ("street_address", "pincode", "area_locality", "city_district", "state")
    )


def _clear_tenant_legacy_address_fields(tenant: Tenant) -> None:
    tenant.address = None
    tenant.street_address = None
    tenant.pincode = None
    tenant.state = None
    tenant.city_district = None
    tenant.area_locality = None
    tenant.country = "India"


def _tenant_has_legacy_address_content(tenant: Tenant) -> bool:
    if (getattr(tenant, "address", None) or "").strip():
        return True
    return any(
        (getattr(tenant, key, None) or "").strip()
        for key in ("street_address", "pincode", "area_locality", "city_district", "state")
    )


def _stored_setting_rows_exist(db: Session, keys: Iterable[str]) -> bool:
    candidate_keys = _candidate_setting_keys_for_many(keys)
    if not candidate_keys:
        return False

    if db.query(TenantSetting.id).filter(TenantSetting.key.in_(candidate_keys)).first():
        return True

    try:
        return db.query(LegacySetting.id).filter(LegacySetting.key.in_(candidate_keys)).first() is not None
    except Exception:
        return False


def _delete_settings(db: Session, keys: Iterable[str]) -> bool:
    candidate_keys = _candidate_setting_keys_for_many(keys)
    if not candidate_keys:
        return False

    changed = False
    rows = db.query(TenantSetting).filter(TenantSetting.key.in_(candidate_keys)).all()
    for row in rows:
        db.delete(row)
    if rows:
        changed = True

    try:
        legacy_rows = db.query(LegacySetting).filter(LegacySetting.key.in_(candidate_keys)).all()
    except Exception:
        legacy_rows = []

    for row in legacy_rows:
        db.delete(row)
    if legacy_rows:
        changed = True

    return changed


def _delete_legacy_company_address_settings(db: Session) -> bool:
    return _delete_settings(db, COMPANY_ADDRESS_SETTING_KEYS)


def _load_company_addresses(db: Session) -> List[TenantAddress]:
    _ensure_company_address_table(db)
    return (
        db.query(TenantAddress)
        .filter(TenantAddress.is_active == True)
        .order_by(TenantAddress.sort_order.asc(), TenantAddress.id.asc())
        .all()
    )


def _serialize_company_address(row: TenantAddress) -> Dict[str, Any]:
    return {
        "id": row.id,
        "label": (row.label or "").strip(),
        "street_address": (row.street_address or "").strip() or None,
        "pincode": (row.pincode or "").strip() or None,
        "area_locality": (row.area_locality or "").strip() or None,
        "city_district": (row.city_district or "").strip() or None,
        "state": (row.state or "").strip() or None,
        "country": (row.country or "India").strip() or "India",
        "is_primary": bool(row.is_primary),
        "is_active": bool(row.is_active),
        "sort_order": int(row.sort_order or 0),
    }


COMPANY_ADDRESS_REQUIRED_FIELDS = (
    ("label", "Address label"),
    ("street_address", "Street address"),
    ("pincode", "Pincode"),
    ("area_locality", "Area / Locality"),
    ("city_district", "City / District"),
    ("state", "State"),
    ("country", "Country"),
)


def _company_address_display_name(index: int, row: Dict[str, Any]) -> str:
    return (str(row.get("label") or "").strip() or f"Address {index + 1}")


_COMPANY_ADDRESS_LIMITS = {"label": (2, 100), "street_address": (5, 500), "area_locality": (2, 150),
                           "city_district": (2, 100), "state": (2, 100), "country": (2, 100)}


def _validate_company_address_row(index: int, row: Dict[str, Any]) -> None:
    """Field-level errors keyed ``addresses.<index>.<field>`` (SettingsPage maps them under each input)."""
    errors: Dict[str, str] = {}
    for key, label in COMPANY_ADDRESS_REQUIRED_FIELDS:
        value = (row.get(key) or "").strip()
        if not value:
            errors[f"addresses.{index}.{key}"] = f"{label} is required."
            continue
        try:
            if key == "pincode":
                V.check_pincode(value)
            else:
                mn, mx = _COMPANY_ADDRESS_LIMITS[key]
                V.check_text(value, label, mn, mx)
        except ValueError as exc:
            errors[f"addresses.{index}.{key}"] = str(exc)
    V.raise_field_errors(errors)


_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_HOST_RE = re.compile(r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
_THEME_COLOR_KEYS = ("theme_primary", "theme_secondary", "theme_accent", "theme_sidebar", "theme_success", "theme_warning", "theme_danger")


def _validate_settings_payload(values: Dict[str, Any]) -> None:
    """Format checks for the Settings page fields (mirror SettingsPage.tsx); optional values are checked only when filled."""
    errors: Dict[str, str] = {}

    def txt(key: str) -> str:
        v = values.get(key)
        return "" if v is None else str(v)

    def check(key: str, fn) -> None:
        if key not in values:
            return
        try:
            fn(txt(key))
        except ValueError as exc:
            errors[key] = str(exc)

    def company_name(v: str) -> None:
        if v and not v.strip():
            raise ValueError("Company name cannot be blank or only spaces.")
        V.check_text(v, "Company name", 2, 200)

    def smtp_host(v: str) -> None:
        if v.strip() and not _HOST_RE.match(v.strip()):
            raise ValueError("Enter a valid SMTP host (e.g. smtp.gmail.com).")

    def smtp_port(v: str) -> None:
        s = v.strip()
        if s and (not s.isdigit() or not 1 <= int(s) <= 65535):
            raise ValueError("Port must be a whole number between 1 and 65535.")

    def color(label: str):
        def _c(v: str) -> None:
            if v.strip() and not _HEX_COLOR_RE.match(v.strip()):
                raise ValueError(f"{label} must be a hex colour like #0F6E8C.")
        return _c

    def auto_approve(v: str) -> None:
        V.check_amount(v, "Auto approve time")

    def advance_days(v: str) -> None:
        s = v.strip()
        if s and (not s.isdigit() or int(s) > 30):
            raise ValueError("Prior travel request days must be a whole number between 0 and 30.")

    check("company_name", company_name)
    check(SMTP_USER_KEY, V.check_email)
    check(SMTP_HOST_KEY, smtp_host)
    check(SMTP_PORT_KEY, smtp_port)
    for key in _THEME_COLOR_KEYS:
        check(key, color(key.replace("theme_", "").capitalize() + " colour"))
    check("travel_auto_approve_minutes", auto_approve)
    check("travel_request_advance_days", advance_days)
    V.raise_field_errors(errors)


def _master_company_address_table_exists(master_db: Session) -> bool:
    try:
        return "tenant_addresses" in inspect(master_db.get_bind()).get_table_names()
    except Exception:
        return False


def _load_master_company_addresses(master_db: Session, tenant_id: int) -> List[Dict[str, Any]]:
    if not _master_company_address_table_exists(master_db):
        return []

    rows = master_db.execute(
        text(
            """
            SELECT
                id,
                label,
                street_address,
                pincode,
                area_locality,
                city_district,
                state,
                country,
                is_primary,
                is_active,
                sort_order
            FROM tenant_addresses
            WHERE tenant_id = :tenant_id
            ORDER BY sort_order ASC, id ASC
            """
        ),
        {"tenant_id": tenant_id},
    ).mappings().all()

    return [dict(row) for row in rows]


def _has_master_company_addresses(master_db: Session, tenant_id: int) -> bool:
    if not _master_company_address_table_exists(master_db):
        return False

    row = master_db.execute(
        text(
            """
            SELECT 1
            FROM tenant_addresses
            WHERE tenant_id = :tenant_id
            LIMIT 1
            """
        ),
        {"tenant_id": tenant_id},
    ).first()
    return row is not None


def _delete_master_company_addresses(master_db: Session, tenant_id: int) -> bool:
    if not _master_company_address_table_exists(master_db):
        return False

    result = master_db.execute(
        text("DELETE FROM tenant_addresses WHERE tenant_id = :tenant_id"),
        {"tenant_id": tenant_id},
    )
    rowcount = getattr(result, "rowcount", None)
    return rowcount is None or rowcount < 0 or rowcount > 0


def _normalize_legacy_company_address_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized_rows: List[Dict[str, Any]] = []

    for raw_row in rows:
        row = {
            "label": (str(raw_row.get("label") or "").strip() or ""),
            "street_address": _clean_nullable_string(raw_row.get("street_address")),
            "pincode": _clean_nullable_string(raw_row.get("pincode")),
            "area_locality": _clean_nullable_string(raw_row.get("area_locality")),
            "city_district": _clean_nullable_string(raw_row.get("city_district")),
            "state": _clean_nullable_string(raw_row.get("state")),
            "country": _clean_nullable_string(raw_row.get("country")) or "India",
            "is_primary": bool(raw_row.get("is_primary")),
            "is_active": bool(raw_row.get("is_active", True)),
            "sort_order": len(normalized_rows),
        }

        has_content = bool(row["label"]) or _company_address_has_content(row)
        if not has_content:
            continue

        if not row["label"]:
            row["label"] = "Head office" if not normalized_rows else f"Address {len(normalized_rows) + 1}"

        normalized_rows.append(row)

    primary_index: Optional[int] = None
    for index, row in enumerate(normalized_rows):
        if row["is_primary"]:
            primary_index = index
            break

    if normalized_rows and primary_index is None:
        normalized_rows[0]["is_primary"] = True
    elif primary_index is not None:
        for index, row in enumerate(normalized_rows):
            row["is_primary"] = index == primary_index

    for index, row in enumerate(normalized_rows):
        row["sort_order"] = index

    return normalized_rows


def _replace_company_addresses(db: Session, rows: List[Dict[str, Any]]) -> None:
    _ensure_company_address_table(db)

    for existing_row in db.query(TenantAddress).all():
        db.delete(existing_row)

    for index, row in enumerate(rows):
        db.add(TenantAddress(
            label=row["label"],
            street_address=row.get("street_address"),
            pincode=row.get("pincode"),
            area_locality=row.get("area_locality"),
            city_district=row.get("city_district"),
            state=row.get("state"),
            country=row.get("country") or "India",
            is_primary=bool(row.get("is_primary")),
            is_active=bool(row.get("is_active", True)),
            sort_order=index,
        ))


def _normalize_company_addresses(addresses: List[CompanyAddressItem]) -> List[Dict[str, Any]]:
    normalized_rows: List[Dict[str, Any]] = []

    for index, item in enumerate(addresses):
        label = (item.label or "").strip()
        row = {
            "label": label,
            "street_address": _clean_nullable_string(item.street_address),
            "pincode": _clean_nullable_string(item.pincode),
            "area_locality": _clean_nullable_string(item.area_locality),
            "city_district": _clean_nullable_string(item.city_district),
            "state": _clean_nullable_string(item.state),
            "country": _clean_nullable_string(item.country),
            "is_primary": bool(item.is_primary),
            "is_active": True,
            "sort_order": len(normalized_rows) if item.sort_order is None else int(item.sort_order),
        }

        _validate_company_address_row(index, row)
        row["sort_order"] = len(normalized_rows)
        normalized_rows.append(row)

    primary_index: Optional[int] = None
    for index, row in enumerate(normalized_rows):
        if row["is_primary"]:
            primary_index = index
            break

    if normalized_rows and primary_index is None:
        normalized_rows[0]["is_primary"] = True
    elif primary_index is not None:
        for index, row in enumerate(normalized_rows):
            row["is_primary"] = index == primary_index

    for index, row in enumerate(normalized_rows):
        row["sort_order"] = index

    return normalized_rows


def _sync_company_addresses_from_legacy_store(db: Session, master_db: Session, tenant: Tenant) -> bool:
    _ensure_company_address_table(db)
    changed = False

    existing_rows = _load_company_addresses(db)
    has_master_rows = _has_master_company_addresses(master_db, tenant.id)
    has_tenant_legacy_content = _tenant_has_legacy_address_content(tenant)
    has_legacy_setting_rows = _stored_setting_rows_exist(db, COMPANY_ADDRESS_SETTING_KEYS)

    if existing_rows:
        primary_rows = [row for row in existing_rows if row.is_primary]
        if len(primary_rows) != 1:
            for index, row in enumerate(existing_rows):
                row.is_primary = index == 0
            changed = True

        # Skip the expensive legacy cleanup pass when addresses are already normalized
        # and there is no remaining legacy data to migrate or delete.
        if not changed and not has_master_rows and not has_tenant_legacy_content and not has_legacy_setting_rows:
            return False

        if has_master_rows:
            changed = _delete_master_company_addresses(master_db, tenant.id) or changed

        if has_tenant_legacy_content or has_legacy_setting_rows:
            legacy_payload = _legacy_tenant_address_payload(tenant, db)
            if _company_address_has_content(legacy_payload) or (getattr(tenant, "address", None) or "").strip():
                _clear_tenant_legacy_address_fields(tenant)
                changed = True
        if _delete_legacy_company_address_settings(db):
            changed = True
        return changed

    if not has_master_rows and not has_tenant_legacy_content and not has_legacy_setting_rows:
        return False

    master_rows = _normalize_legacy_company_address_rows(
        _load_master_company_addresses(master_db, tenant.id) if has_master_rows else []
    )
    if master_rows:
        _replace_company_addresses(db, master_rows)
        changed = _delete_master_company_addresses(master_db, tenant.id) or changed
        _clear_tenant_legacy_address_fields(tenant)
        if _delete_legacy_company_address_settings(db):
            changed = True
        changed = True
        return changed

    legacy_payload = _legacy_tenant_address_payload(tenant, db)
    if not _company_address_has_content(legacy_payload) and not (getattr(tenant, "address", None) or "").strip():
        if _delete_legacy_company_address_settings(db):
            changed = True
        return changed

    db.add(TenantAddress(
        label="Head office",
        street_address=legacy_payload["street_address"],
        pincode=legacy_payload["pincode"],
        area_locality=legacy_payload["area_locality"],
        city_district=legacy_payload["city_district"],
        state=legacy_payload["state"],
        country=legacy_payload["country"] or "India",
        is_primary=True,
        is_active=True,
        sort_order=0,
    ))
    if has_master_rows:
        changed = _delete_master_company_addresses(master_db, tenant.id) or changed
    _clear_tenant_legacy_address_fields(tenant)
    if _delete_legacy_company_address_settings(db):
        changed = True
    changed = True
    return changed


def _normalize_bool_value(raw_value: Any) -> bool:
    if isinstance(raw_value, bool):
        return raw_value

    value = _serialize_value(raw_value).strip().lower()
    if value in {"true", "1", "yes", "on"}:
        return True
    if value in {"false", "0", "no", "off", ""}:
        return False
    raise HTTPException(status_code=400, detail="Boolean setting must be true or false")


def _serialize_bool_setting(value: Any, default: bool = False) -> str:
    return "true" if bool(default if value is None else value) else "false"


def _get_tenant_smtp_host_value(tenant: Tenant) -> str:
    return (tenant.smtp_host or "").strip()


def _get_tenant_smtp_port_value(tenant: Tenant) -> str:
    return str(tenant.smtp_port) if tenant.smtp_port is not None else ""


def _get_tenant_smtp_security_value(tenant: Tenant) -> str:
    if getattr(tenant, "smtp_use_ssl", False):
        return SMTP_SECURITY_SSL
    if getattr(tenant, "smtp_use_tls", False):
        return SMTP_SECURITY_TLS
    if getattr(tenant, "smtp_port", None) == 465:
        return SMTP_SECURITY_SSL
    return SMTP_SECURITY_TLS


def _normalize_smtp_port_value(raw_value: Any) -> Optional[int]:
    value = _serialize_value(raw_value).strip()
    if not value:
        return None

    try:
        port = int(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="SMTP port must be a valid number") from exc

    if port < 1 or port > 65535:
        raise HTTPException(status_code=400, detail="SMTP port must be between 1 and 65535")

    return port


def _normalize_smtp_security_value(raw_value: Any) -> str:
    value = _serialize_value(raw_value).strip().upper()
    if value in {SMTP_SECURITY_TLS, SMTP_SECURITY_SSL}:
        return value
    raise HTTPException(status_code=400, detail="SMTP security must be TLS or SSL")


def _normalize_captcha_mode_value(raw_value: Any) -> str:
    value = _serialize_value(raw_value).strip()
    if value in {"after_failed", "always", "never"}:
        return value
    return "after_failed"


def _apply_tenant_smtp_security(tenant: Tenant, raw_value: Any) -> str:
    security = _normalize_smtp_security_value(raw_value)
    tenant.smtp_use_ssl = security == SMTP_SECURITY_SSL
    tenant.smtp_use_tls = security == SMTP_SECURITY_TLS
    return security


def _apply_tenant_smtp_user(tenant: Tenant, raw_value: Any) -> Optional[str]:
    previous_smtp_user = (tenant.smtp_user or "").strip() or None
    previous_from_email = (tenant.from_email or "").strip() or None
    smtp_user = _clean_nullable_string(raw_value)
    tenant.smtp_user = smtp_user
    if not previous_from_email or previous_from_email == previous_smtp_user:
        tenant.from_email = smtp_user
    return smtp_user


def _apply_tenant_mail(tenant: Tenant, raw_value: Any) -> Optional[str]:
    mail = _clean_nullable_string(raw_value)
    tenant.from_email = mail
    return mail


def _get_setting_row(db: Session, key: str) -> Optional[TenantSetting]:
    return db.query(TenantSetting).filter(TenantSetting.key.in_(_candidate_setting_keys(key))).first()


def _sync_tenant_managed_settings_from_legacy_store(db: Session, tenant: Tenant) -> bool:
    changed = False

    needs_company_mail = not (getattr(tenant, "company_mail", None) or "").strip()
    needs_address = not (getattr(tenant, "address", None) or "").strip()
    needs_street_address = not (getattr(tenant, "street_address", None) or "").strip()
    needs_country = not (getattr(tenant, "country", None) or "").strip()
    needs_smtp_host = not (tenant.smtp_host or "").strip()
    needs_smtp_port = tenant.smtp_port is None
    needs_smtp_user = not (tenant.smtp_user or "").strip()
    needs_mail = not (tenant.from_email or "").strip()
    needs_smtp_password = not (tenant.smtp_password or "").strip()

    if not any((
        needs_company_mail,
        needs_address,
        needs_street_address,
        needs_country,
        needs_smtp_host,
        needs_smtp_port,
        needs_smtp_user,
        needs_mail,
        needs_smtp_password,
    )):
        return False

    if needs_company_mail:
        legacy_company_mail = _clean_nullable_string(_get_stored_setting_value(db, COMPANY_MAIL_KEY))
    else:
        legacy_company_mail = None
    if needs_company_mail and legacy_company_mail:
        tenant.company_mail = legacy_company_mail
        changed = True

    if needs_address or needs_street_address:
        legacy_address = _clean_nullable_string(_get_stored_setting_value(db, ADDRESS_KEY))
    else:
        legacy_address = None
    if needs_address and legacy_address:
        tenant.address = legacy_address
        changed = True

    if needs_street_address and legacy_address:
        tenant.street_address = legacy_address
        changed = True

    if needs_country:
        tenant.country = "India"
        changed = True

    smtp_fields_synced = False

    if needs_smtp_host:
        legacy_smtp_host = _clean_nullable_string(_get_stored_setting_value(db, SMTP_HOST_KEY))
    else:
        legacy_smtp_host = None
    if needs_smtp_host and legacy_smtp_host:
        tenant.smtp_host = legacy_smtp_host
        changed = True
        smtp_fields_synced = True

    if needs_smtp_port:
        legacy_smtp_port = _get_stored_setting_value(db, SMTP_PORT_KEY)
    else:
        legacy_smtp_port = None
    if needs_smtp_port:
        try:
            parsed_port = _normalize_smtp_port_value(legacy_smtp_port)
        except HTTPException:
            parsed_port = None
        if parsed_port is not None:
            tenant.smtp_port = parsed_port
            changed = True
            smtp_fields_synced = True

    if needs_smtp_user:
        legacy_smtp_user = _clean_nullable_string(_get_stored_setting_value(db, SMTP_USER_KEY))
    else:
        legacy_smtp_user = None
    if needs_smtp_user and legacy_smtp_user:
        _apply_tenant_smtp_user(tenant, legacy_smtp_user)
        changed = True
        smtp_fields_synced = True

    if needs_mail:
        legacy_mail = _clean_nullable_string(_get_stored_setting_value(db, MAIL_KEY))
    else:
        legacy_mail = None
    if not (tenant.from_email or "").strip() and legacy_mail:
        _apply_tenant_mail(tenant, legacy_mail)
        changed = True
        smtp_fields_synced = True

    if needs_smtp_password:
        legacy_smtp_password = _clean_nullable_string(_get_stored_setting_value(db, SMTP_PASSWORD_KEY))
    else:
        legacy_smtp_password = None
    if needs_smtp_password and legacy_smtp_password:
        tenant.smtp_password = legacy_smtp_password
        changed = True
        smtp_fields_synced = True

    if smtp_fields_synced:
        legacy_smtp_security = _clean_nullable_string(_get_stored_setting_value(db, SMTP_SECURITY_KEY))
    else:
        legacy_smtp_security = None
    if legacy_smtp_security:
        try:
            _apply_tenant_smtp_security(tenant, legacy_smtp_security)
            changed = True
        except HTTPException:
            logger.warning("Ignoring invalid legacy SMTP security value for tenant=%s", tenant.slug)

    return changed


def _uploads_root() -> Path:
    return Path(settings.UPLOAD_DIR).resolve()


def _resolve_upload_file(raw_path: Optional[str]) -> Optional[Path]:
    clean_path = (raw_path or "").strip()
    if not clean_path.startswith("/uploads/"):
        return None

    relative_path = clean_path[len("/uploads/"):].lstrip("/")
    candidate = (_uploads_root() / relative_path).resolve()

    try:
        candidate.relative_to(_uploads_root())
    except ValueError:
        return None

    return candidate


def _logo_version(raw_path: Optional[str], updated_at: Optional[datetime]) -> str:
    if updated_at:
        try:
            return str(int(updated_at.timestamp()))
        except Exception:
            pass

    logo_file = _resolve_upload_file(raw_path)
    if logo_file and logo_file.exists():
        return str(int(logo_file.stat().st_mtime))
    return ""


def _delete_setting(db: Session, key: str) -> None:
    _delete_settings(db, (key,))


def _get_all(db: Session) -> Dict[str, Dict[str, Any]]:
    _ensure_table(db)

    result = {key: {"value": meta["value"], "type": meta["type"]} for key, meta in DEFAULTS.items()}
    result[LOGO_VERSION_KEY] = {"value": "", "type": "string"}

    for key, meta in _load_legacy_settings(db).items():
        result[key] = meta

    rows = db.query(TenantSetting).all()
    for row in rows:
        if row.key.startswith(INTERNAL_SETTING_PREFIX):
            continue
        canonical_key = _normalize_setting_key(row.key)
        result[canonical_key] = {
            "value": row.value or "",
            "type": row.value_type or DEFAULTS.get(canonical_key, {}).get("type", "string"),
        }
        if canonical_key == LOGO_SETTING_KEY:
            result[LOGO_VERSION_KEY] = {
                "value": _logo_version(row.value, row.updated_at),
                "type": "string",
            }

    if not result[LOGO_VERSION_KEY]["value"]:
        result[LOGO_VERSION_KEY] = {
            "value": _logo_version(result.get(LOGO_SETTING_KEY, {}).get("value"), None),
            "type": "string",
        }

    return result


def _upsert(db: Session, key: str, value: str, value_type: str = "string") -> None:
    canonical_key = _normalize_setting_key(key)
    candidate_keys = _candidate_setting_keys(canonical_key)

    row = db.query(TenantSetting).filter(TenantSetting.key.in_(candidate_keys)).first()
    if row:
        row.key = canonical_key
        row.value = value
        row.value_type = value_type
        row.updated_at = now_ist()
    else:
        db.add(TenantSetting(
            key=canonical_key,
            value=value,
            value_type=value_type,
            updated_at=now_ist(),
        ))

    _sync_legacy_setting(db, canonical_key, value, value_type)


@router.get("/theme", response_model=ThemeSettingsResponse)
def get_theme(
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
):
    tenant_slug = tenant_slug_from_db(db)
    cache_key = theme_cache_key(tenant_slug, "theme") if tenant_slug else ""
    if cache_key:
        cached = cache_get_json(cache_key, "theme")
        if cached is not None:
            return cached

    all_settings = _get_all(db)
    tenant = _get_master_tenant(request, master_db)

    def v(key: str) -> str:
        return str(all_settings.get(key, {}).get("value", DEFAULTS.get(key, {}).get("value", "")))

    # Use tenant.name from master DB as company_name when the settings table
    # has no override (avoids seeding a hardcoded default on every new tenant).
    stored_company_name = all_settings.get("company_name", {}).get("value", "")
    effective_company_name = stored_company_name or (tenant.name if tenant else "") or v("company_name")

    response = {
        "theme_primary": v("theme_primary"),
        "theme_secondary": v("theme_secondary"),
        "theme_accent": v("theme_accent"),
        "theme_sidebar": v("theme_sidebar"),
        "theme_success": v("theme_success"),
        "theme_warning": v("theme_warning"),
        "theme_danger": v("theme_danger"),
        "theme_font": v("theme_font"),
        "theme_font_size": v("theme_font_size"),
        "company_name": effective_company_name,
        "theme_logo": v(LOGO_SETTING_KEY),
        "theme_logo_version": v(LOGO_VERSION_KEY),
        "company_logo": v(LOGO_SETTING_KEY),
        "primary_color": v("theme_primary"),
        "secondary_color": v("theme_secondary"),
        "accent_color": v("theme_accent"),
        "sidebar_color": v("theme_sidebar"),
        "success_color": v("theme_success"),
        "warning_color": v("theme_warning"),
        "danger_color": v("theme_danger"),
        "font_family": v("theme_font"),
        "font_size": v("theme_font_size"),
        "logo_url": v(LOGO_SETTING_KEY),
        "forgot_password_enabled": bool(getattr(tenant, FORGOT_PASSWORD_ENABLED_KEY, True)),
    }
    if cache_key:
        cache_set_json(cache_key, response, CACHE_TTL_SECONDS["theme"])
    return response


@router.get("/settings", response_model=Dict[str, SettingValueResponse])
def get_settings(
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    _: User = Depends(get_current_user),
):
    tenant_slug = tenant_slug_from_db(db)
    cache_key = theme_cache_key(tenant_slug, "settings") if tenant_slug else ""
    if cache_key:
        cached = cache_get_json(cache_key, "settings")
        if cached is not None:
            return cached

    all_settings = _get_all(db)
    tenant = _get_master_tenant(request, master_db)
    if _sync_tenant_managed_settings_from_legacy_store(db, tenant):
        master_db.commit()
    if not all_settings.get("company_name", {}).get("value"):
        all_settings["company_name"] = {"value": tenant.name if tenant else "", "type": "string"}
    all_settings[COMPANY_MAIL_KEY] = {"value": _get_tenant_company_mail_value(tenant), "type": "string"}
    all_settings[ADDRESS_KEY] = {"value": _get_tenant_address_value(tenant), "type": "string"}
    all_settings[STREET_ADDRESS_KEY] = {"value": _get_tenant_street_address_value(tenant), "type": "string"}
    all_settings[PINCODE_KEY] = {"value": _get_tenant_pincode_value(tenant), "type": "string"}
    all_settings[COUNTRY_KEY] = {"value": _get_tenant_country_value(tenant), "type": "string"}
    all_settings[STATE_KEY] = {"value": _get_tenant_state_value(tenant), "type": "string"}
    all_settings[CITY_DISTRICT_KEY] = {"value": _get_tenant_city_district_value(tenant), "type": "string"}
    all_settings[AREA_LOCALITY_KEY] = {"value": _get_tenant_area_locality_value(tenant), "type": "string"}
    all_settings[FORGOT_PASSWORD_ENABLED_KEY] = {"value": _serialize_bool_setting(getattr(tenant, FORGOT_PASSWORD_ENABLED_KEY, True), True), "type": "bool"}
    all_settings[FORCE_PASSWORD_CHANGE_ON_FIRST_LOGIN_KEY] = {"value": _serialize_bool_setting(getattr(tenant, FORCE_PASSWORD_CHANGE_ON_FIRST_LOGIN_KEY, False)), "type": "bool"}
    all_settings[NEW_DEVICE_LOGIN_ALERT_ENABLED_KEY] = {"value": _serialize_bool_setting(getattr(tenant, NEW_DEVICE_LOGIN_ALERT_ENABLED_KEY, False)), "type": "bool"}
    all_settings[OTP_MODE_KEY] = {"value": str(getattr(tenant, OTP_MODE_KEY, 'always') or 'always'), "type": "string"}
    all_settings[CAPTCHA_MODE_KEY] = {"value": _normalize_captcha_mode_value(getattr(tenant, CAPTCHA_MODE_KEY, 'after_failed') or 'after_failed'), "type": "string"}
    all_settings[SMTP_HOST_KEY] = {"value": _get_tenant_smtp_host_value(tenant), "type": "string"}
    all_settings[SMTP_PORT_KEY] = {"value": _get_tenant_smtp_port_value(tenant), "type": "string"}
    all_settings[SMTP_USER_KEY] = {"value": _get_tenant_smtp_user_value(tenant), "type": "string"}
    all_settings[MAIL_KEY] = {"value": _get_tenant_mail_value(tenant), "type": "string"}
    all_settings[SMTP_PASSWORD_KEY] = {"value": "", "type": "password"}
    all_settings[SMTP_SECURITY_KEY] = {"value": _get_tenant_smtp_security_value(tenant), "type": "string"}
    all_settings[MAX_USERS_KEY] = {"value": str(int(tenant.max_users or 5)), "type": "number"}
    active_count = db.query(User).filter(User.is_active == True).count()
    all_settings[ACTIVE_USER_COUNT_KEY] = {"value": str(active_count), "type": "number"}
    if cache_key:
        cache_set_json(cache_key, all_settings, CACHE_TTL_SECONDS["theme"])
    return all_settings


@router.get("/notification-recipient-types", response_model=NotificationRecipientTypesResponse)
def get_notification_recipient_types(
    module: str = Query(...),
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    ensure_notification_catalog_seeded(db)
    db.commit()
    normalized_module_key = normalize_notification_module_key(module)
    if normalized_module_key not in {item["key"] for item in list_supported_notification_modules()}:
        raise HTTPException(status_code=404, detail=f"Unsupported notification module: {module}")
    return _build_notification_recipient_types_response(normalized_module_key)


@router.get("/notification-events", response_model=NotificationEventsResponse)
def get_notification_events(
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    ensure_notification_catalog_seeded(db)
    db.commit()
    return _build_notification_events_response(db)


@router.get("/notification-rules", response_model=NotificationRuleListResponse)
def get_notification_rules(
    module: Optional[str] = Query(None),
    module_key: Optional[str] = Query(None),
    event_key: Optional[str] = Query(None),
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    ensure_notification_catalog_seeded(db)
    db.commit()
    return _build_notification_rules_response(db, module_key=module_key or module, event_key=event_key)


@router.put("/notification-rules", response_model=NotificationRuleListResponse)
def save_notification_rules(
    payload: Dict[str, Any],
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    ensure_notification_catalog_seeded(db)
    normalized_payload = _normalize_notification_rule_payload(payload)

    target_event_definition_ids = sorted(
        {
            int(event_definition_id)
            for event_definition_id in [
                *(normalized_payload.replace_event_definition_ids or []),
                *[rule.event_definition_id for rule in normalized_payload.rules],
            ]
            if event_definition_id
        }
    )
    if not target_event_definition_ids:
        raise HTTPException(status_code=400, detail="No notification event definitions were provided")

    definition_map = _load_notification_definition_map(db, target_event_definition_ids)
    if len(definition_map) != len(target_event_definition_ids):
        missing_ids = sorted(set(target_event_definition_ids) - set(definition_map.keys()))
        raise HTTPException(status_code=400, detail=f"Unknown notification event definitions: {missing_ids}")

    items_by_event: Dict[int, NotificationRuleItem] = {}
    for item in normalized_payload.rules:
        _validate_notification_rule_item(item, definition_map)
        items_by_event[item.event_definition_id] = item

    existing_rows = (
        db.query(NotificationRule)
        .filter(NotificationRule.event_definition_id.in_(target_event_definition_ids))
        .all()
    )
    for row in existing_rows:
        db.delete(row)
    db.flush()

    for event_definition_id in target_event_definition_ids:
        item = items_by_event.get(event_definition_id)
        if not item:
            continue

        definition = definition_map[event_definition_id]
        mapped_recipients = map_ui_to_resolver_keys(
            definition.module_key,
            definition.event_key,
            {
                "linked_users": item.linked_users,
                "manager": item.manager,
                "admin": item.admin,
                "ceo": item.ceo,
            },
        )
        # The settings UI only exposes the visible recipient columns
        # (linked users, manager, admin, CEO). Persist exactly those
        # selections here so hidden legacy/default resolvers do not make
        # unchecked modules appear enabled again after reload.
        resolved_recipients = sorted(dict.fromkeys(mapped_recipients))
        is_active = bool(item.is_active)
        if is_active and not resolved_recipients:
            raise HTTPException(
                status_code=400,
                detail=f"{definition.label}: active notification rules must resolve to at least one recipient",
            )

        for sort_order, recipient_key in enumerate(resolved_recipients):
            db.add(NotificationRule(
                event_definition_id=event_definition_id,
                channel="both",
                recipient_type=recipient_key,
                recipient_role=None,
                recipient_user_id=None,
                record_field_name=None,
                condition_json=item.condition_json,
                is_active=is_active,
                sort_order=sort_order,
            ))

    db.commit()
    return _build_notification_rules_response(db)


@router.get("/notification-templates", response_model=NotificationTemplateListResponse)
def get_notification_templates(
    module: Optional[str] = Query(None),
    module_key: Optional[str] = Query(None),
    event_key: Optional[str] = Query(None),
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    ensure_notification_catalog_seeded(db)
    db.commit()
    return _build_notification_templates_response(db, module_key=module_key or module, event_key=event_key)


@router.put("/notification-templates", response_model=NotificationTemplateListResponse)
def save_notification_templates(
    payload: Dict[str, Any],
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    ensure_notification_catalog_seeded(db)
    normalized_payload = _normalize_notification_template_payload(payload)

    target_event_definition_ids = sorted(
        {
            int(event_definition_id)
            for event_definition_id in [
                *(normalized_payload.replace_event_definition_ids or []),
                *[template.event_definition_id for template in normalized_payload.templates],
            ]
            if event_definition_id
        }
    )
    if not target_event_definition_ids:
        raise HTTPException(status_code=400, detail="No notification event definitions were provided")

    definition_map = _load_notification_definition_map(db, target_event_definition_ids)
    if len(definition_map) != len(target_event_definition_ids):
        missing_ids = sorted(set(target_event_definition_ids) - set(definition_map.keys()))
        raise HTTPException(status_code=400, detail=f"Unknown notification event definitions: {missing_ids}")

    items_by_event: Dict[int, NotificationTemplateItem] = {}
    for item in normalized_payload.templates:
        _validate_notification_template_item(item, definition_map)
        items_by_event[item.event_definition_id] = item

    existing_rows = (
        db.query(NotificationTemplate)
        .filter(NotificationTemplate.event_definition_id.in_(target_event_definition_ids))
        .all()
    )
    existing_by_key = {(row.event_definition_id, row.channel): row for row in existing_rows}
    existing_by_event: Dict[int, List[NotificationTemplate]] = {}
    for row in existing_rows:
        existing_by_event.setdefault(int(row.event_definition_id), []).append(row)

    for event_definition_id in target_event_definition_ids:
        item = items_by_event.get(event_definition_id)
        if not item:
            for row in existing_by_event.get(event_definition_id, []):
                db.delete(row)
            continue

        for channel in ("in_app", "email"):
            row = existing_by_key.get((event_definition_id, channel))
            if row is None:
                row = NotificationTemplate(
                    event_definition_id=event_definition_id,
                    channel=channel,
                )
                db.add(row)

            row.event_definition_id = event_definition_id
            row.channel = channel
            row.subject_template = (item.subject_template or "").strip() or None
            row.body_template = (item.body_template or "").strip() or None
            row.html_template = (item.html_template or "").strip() or None
            row.action_url_template = (item.action_url_template or "").strip() or None
            row.is_active = bool(item.is_active)

        for row in existing_by_event.get(event_definition_id, []):
            if row.channel not in {"in_app", "email"}:
                db.delete(row)

    db.commit()
    return _build_notification_templates_response(db)


@router.get("/company-addresses", response_model=CompanyAddressListResponse)
def get_company_addresses(
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    _: User = Depends(get_current_user),
):
    tenant = _get_master_tenant(request, master_db)
    if _sync_company_addresses_from_legacy_store(db, master_db, tenant):
        db.commit()
        master_db.commit()

    rows = _load_company_addresses(db)
    return {"addresses": [_serialize_company_address(row) for row in rows]}


@router.put("/company-addresses", response_model=CompanyAddressListResponse)
def save_company_addresses(
    payload: CompanyAddressUpdatePayload,
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    _: User = Depends(get_current_user),
):
    try:
        tenant = _get_master_tenant(request, master_db)
        _ensure_company_address_table(db)
        normalized_rows = _normalize_company_addresses(payload.addresses or [])
        _replace_company_addresses(db, normalized_rows)
        _delete_master_company_addresses(master_db, tenant.id)
        _clear_tenant_legacy_address_fields(tenant)
        _delete_legacy_company_address_settings(db)
        db.commit()
        master_db.commit()

        rows = _load_company_addresses(db)
        return {"addresses": [_serialize_company_address(row) for row in rows]}
    except HTTPException:
        master_db.rollback()
        db.rollback()
        raise
    except Exception as exc:
        master_db.rollback()
        db.rollback()
        logger.exception("save_company_addresses failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed to save company addresses: {exc}") from exc


@router.put("/settings", response_model=SaveSettingsResponse)
def save_settings(
    payload: BulkSettingsPayload,
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    current_user: User = Depends(get_current_user),
):
    _validate_settings_payload({_normalize_setting_key(k): v for k, v in payload.root.items()})
    invalidate_theme_cache(db)
    try:
        _ensure_table(db)
        tenant = _get_master_tenant(request, master_db)
        updated_count = 0

        for incoming_key, raw_value in payload.root.items():
            canonical_key = _normalize_setting_key(incoming_key)
            if canonical_key in READ_ONLY_KEYS:
                continue
            if canonical_key == COMPANY_MAIL_KEY:
                tenant.company_mail = _clean_nullable_string(raw_value)
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == ADDRESS_KEY:
                tenant.address = _clean_nullable_string(raw_value)
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == STREET_ADDRESS_KEY:
                tenant.street_address = _clean_nullable_string(raw_value)
                _delete_setting(db, canonical_key)
                _delete_setting(db, ADDRESS_KEY)
                updated_count += 1
                continue
            if canonical_key == PINCODE_KEY:
                tenant.pincode = _clean_nullable_string(raw_value)
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == COUNTRY_KEY:
                tenant.country = _clean_nullable_string(raw_value) or "India"
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == STATE_KEY:
                tenant.state = _clean_nullable_string(raw_value)
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == CITY_DISTRICT_KEY:
                tenant.city_district = _clean_nullable_string(raw_value)
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == AREA_LOCALITY_KEY:
                tenant.area_locality = _clean_nullable_string(raw_value)
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == FORGOT_PASSWORD_ENABLED_KEY:
                setattr(tenant, FORGOT_PASSWORD_ENABLED_KEY, _normalize_bool_value(raw_value))
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == FORCE_PASSWORD_CHANGE_ON_FIRST_LOGIN_KEY:
                setattr(tenant, FORCE_PASSWORD_CHANGE_ON_FIRST_LOGIN_KEY, _normalize_bool_value(raw_value))
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == NEW_DEVICE_LOGIN_ALERT_ENABLED_KEY:
                setattr(tenant, NEW_DEVICE_LOGIN_ALERT_ENABLED_KEY, _normalize_bool_value(raw_value))
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == OTP_MODE_KEY:
                _v = str(raw_value).strip()
                setattr(tenant, OTP_MODE_KEY, _v if _v in ('first_login', 'never') else 'always')
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == CAPTCHA_MODE_KEY:
                setattr(tenant, CAPTCHA_MODE_KEY, _normalize_captcha_mode_value(raw_value))
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == SMTP_HOST_KEY:
                tenant.smtp_host = _clean_nullable_string(raw_value)
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == SMTP_PORT_KEY:
                tenant.smtp_port = _normalize_smtp_port_value(raw_value)
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == SMTP_USER_KEY:
                _apply_tenant_smtp_user(tenant, raw_value)
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == MAIL_KEY:
                _apply_tenant_mail(tenant, raw_value)
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            if canonical_key == SMTP_PASSWORD_KEY:
                _delete_setting(db, canonical_key)
                password = _serialize_value(raw_value)
                if password.strip():
                    tenant.smtp_password = password
                    updated_count += 1
                continue
            if canonical_key == SMTP_SECURITY_KEY:
                _apply_tenant_smtp_security(tenant, raw_value)
                _delete_setting(db, canonical_key)
                updated_count += 1
                continue
            value_type = DEFAULTS.get(canonical_key, {}).get("type", "string")
            _upsert(db, canonical_key, _serialize_value(raw_value), value_type)
            updated_count += 1

        if updated_count:
            log_module_action(
                db=db, user_id=current_user.id, module="settings", action="configuration_change",
                record_id=None, record_name="Tenant Settings", ip=get_request_ip(request),
                description=f"Updated {updated_count} tenant setting{'s' if updated_count != 1 else ''}",
                new_data={k: ("••••••" if _normalize_setting_key(k) == "smtp_password" else v) for k, v in payload.root.items()},
            )
        master_db.commit()
        db.commit()
        return {"status": "saved", "count": updated_count}
    except HTTPException:
        master_db.rollback()
        db.rollback()
        raise
    except Exception as exc:
        master_db.rollback()
        db.rollback()
        logger.exception("save_settings failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed to save settings: {exc}") from exc


@router.get("/settings/{key}", response_model=SingleSettingResponse)
def get_single_setting(
    key: str,
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    _: User = Depends(get_current_user),
):
    canonical_key = _normalize_setting_key(key)
    if canonical_key in {
        COMPANY_MAIL_KEY,
        ADDRESS_KEY,
        STREET_ADDRESS_KEY,
        PINCODE_KEY,
        COUNTRY_KEY,
        STATE_KEY,
        CITY_DISTRICT_KEY,
        AREA_LOCALITY_KEY,
        FORGOT_PASSWORD_ENABLED_KEY,
        FORCE_PASSWORD_CHANGE_ON_FIRST_LOGIN_KEY,
        NEW_DEVICE_LOGIN_ALERT_ENABLED_KEY,
        OTP_MODE_KEY,
        CAPTCHA_MODE_KEY,
        SMTP_HOST_KEY,
        SMTP_PORT_KEY,
        SMTP_USER_KEY,
        SMTP_PASSWORD_KEY,
        SMTP_SECURITY_KEY,
        MAIL_KEY,
    }:
        tenant = _get_master_tenant(request, master_db)
        if _sync_tenant_managed_settings_from_legacy_store(db, tenant):
            master_db.commit()
    if canonical_key == COMPANY_MAIL_KEY:
        return {"key": canonical_key, "value": _get_tenant_company_mail_value(tenant), "type": "string"}
    if canonical_key == ADDRESS_KEY:
        return {"key": canonical_key, "value": _get_tenant_address_value(tenant), "type": "string"}
    if canonical_key == STREET_ADDRESS_KEY:
        return {"key": canonical_key, "value": _get_tenant_street_address_value(tenant), "type": "string"}
    if canonical_key == PINCODE_KEY:
        return {"key": canonical_key, "value": _get_tenant_pincode_value(tenant), "type": "string"}
    if canonical_key == COUNTRY_KEY:
        return {"key": canonical_key, "value": _get_tenant_country_value(tenant), "type": "string"}
    if canonical_key == STATE_KEY:
        return {"key": canonical_key, "value": _get_tenant_state_value(tenant), "type": "string"}
    if canonical_key == CITY_DISTRICT_KEY:
        return {"key": canonical_key, "value": _get_tenant_city_district_value(tenant), "type": "string"}
    if canonical_key == AREA_LOCALITY_KEY:
        return {"key": canonical_key, "value": _get_tenant_area_locality_value(tenant), "type": "string"}
    if canonical_key == FORGOT_PASSWORD_ENABLED_KEY:
        return {"key": canonical_key, "value": _serialize_bool_setting(getattr(tenant, canonical_key, True), True), "type": "bool"}
    if canonical_key == FORCE_PASSWORD_CHANGE_ON_FIRST_LOGIN_KEY:
        return {"key": canonical_key, "value": _serialize_bool_setting(getattr(tenant, canonical_key, False)), "type": "bool"}
    if canonical_key == NEW_DEVICE_LOGIN_ALERT_ENABLED_KEY:
        return {"key": canonical_key, "value": _serialize_bool_setting(getattr(tenant, canonical_key, False)), "type": "bool"}
    if canonical_key == OTP_MODE_KEY:
        return {"key": canonical_key, "value": str(getattr(tenant, OTP_MODE_KEY, 'always') or 'always'), "type": "string"}
    if canonical_key == CAPTCHA_MODE_KEY:
        return {"key": canonical_key, "value": _normalize_captcha_mode_value(getattr(tenant, CAPTCHA_MODE_KEY, 'after_failed') or 'after_failed'), "type": "string"}
    if canonical_key == SMTP_HOST_KEY:
        return {"key": canonical_key, "value": _get_tenant_smtp_host_value(tenant), "type": "string"}
    if canonical_key == SMTP_PORT_KEY:
        return {"key": canonical_key, "value": _get_tenant_smtp_port_value(tenant), "type": "string"}
    if canonical_key == SMTP_PASSWORD_KEY:
        return {"key": canonical_key, "value": "", "type": "password"}
    if canonical_key == SMTP_USER_KEY:
        return {"key": canonical_key, "value": _get_tenant_smtp_user_value(tenant), "type": "string"}
    if canonical_key == MAIL_KEY:
        return {"key": canonical_key, "value": _get_tenant_mail_value(tenant), "type": "string"}
    if canonical_key == SMTP_SECURITY_KEY:
        return {"key": canonical_key, "value": _get_tenant_smtp_security_value(tenant), "type": "string"}

    _ensure_table(db)
    row = _get_setting_row(db, canonical_key)
    if row:
        return {"key": canonical_key, "value": row.value or "", "type": row.value_type or "string"}

    settings = _get_all(db)
    if canonical_key in settings:
        return {
            "key": canonical_key,
            "value": str(settings[canonical_key]["value"]),
            "type": settings[canonical_key]["type"],
        }

    raise HTTPException(status_code=404, detail=f"Setting '{key}' not found")


@router.put("/settings/{key}", response_model=SingleSettingResponse)
def update_single_setting(
    key: str,
    data: SingleSettingUpdate,
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    current_user: User = Depends(get_current_user),
):
    canonical_key = _normalize_setting_key(key)
    if canonical_key in READ_ONLY_KEYS:
        raise HTTPException(status_code=400, detail=f"Setting '{key}' is read-only")
    invalidate_theme_cache(db)
    log_module_action(
        db=db, user_id=current_user.id, module="settings", action="configuration_change",
        record_id=None, record_name="Tenant Settings", ip=get_request_ip(request),
        new_data={canonical_key: data.value if canonical_key != "smtp_password" else "••••••"},
    )

    if canonical_key == COMPANY_MAIL_KEY:
        tenant = _get_master_tenant(request, master_db)
        tenant.company_mail = _clean_nullable_string(data.value)
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _get_tenant_company_mail_value(tenant), "type": "string"}

    if canonical_key == ADDRESS_KEY:
        tenant = _get_master_tenant(request, master_db)
        tenant.address = _clean_nullable_string(data.value)
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _get_tenant_address_value(tenant), "type": "string"}

    if canonical_key == STREET_ADDRESS_KEY:
        tenant = _get_master_tenant(request, master_db)
        tenant.street_address = _clean_nullable_string(data.value)
        _delete_setting(db, canonical_key)
        _delete_setting(db, ADDRESS_KEY)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _get_tenant_street_address_value(tenant), "type": "string"}

    if canonical_key == PINCODE_KEY:
        tenant = _get_master_tenant(request, master_db)
        tenant.pincode = _clean_nullable_string(data.value)
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _get_tenant_pincode_value(tenant), "type": "string"}

    if canonical_key == COUNTRY_KEY:
        tenant = _get_master_tenant(request, master_db)
        tenant.country = _clean_nullable_string(data.value) or "India"
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _get_tenant_country_value(tenant), "type": "string"}

    if canonical_key == STATE_KEY:
        tenant = _get_master_tenant(request, master_db)
        tenant.state = _clean_nullable_string(data.value)
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _get_tenant_state_value(tenant), "type": "string"}

    if canonical_key == CITY_DISTRICT_KEY:
        tenant = _get_master_tenant(request, master_db)
        tenant.city_district = _clean_nullable_string(data.value)
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _get_tenant_city_district_value(tenant), "type": "string"}

    if canonical_key == AREA_LOCALITY_KEY:
        tenant = _get_master_tenant(request, master_db)
        tenant.area_locality = _clean_nullable_string(data.value)
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _get_tenant_area_locality_value(tenant), "type": "string"}

    if canonical_key == FORGOT_PASSWORD_ENABLED_KEY:
        tenant = _get_master_tenant(request, master_db)
        setattr(tenant, canonical_key, _normalize_bool_value(data.value))
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _serialize_bool_setting(getattr(tenant, canonical_key, True), True), "type": "bool"}

    if canonical_key == FORCE_PASSWORD_CHANGE_ON_FIRST_LOGIN_KEY:
        tenant = _get_master_tenant(request, master_db)
        setattr(tenant, canonical_key, _normalize_bool_value(data.value))
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _serialize_bool_setting(getattr(tenant, canonical_key, False)), "type": "bool"}

    if canonical_key == NEW_DEVICE_LOGIN_ALERT_ENABLED_KEY:
        tenant = _get_master_tenant(request, master_db)
        setattr(tenant, canonical_key, _normalize_bool_value(data.value))
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _serialize_bool_setting(getattr(tenant, canonical_key, False)), "type": "bool"}

    if canonical_key == OTP_MODE_KEY:
        tenant = _get_master_tenant(request, master_db)
        _v = str(data.value).strip()
        setattr(tenant, OTP_MODE_KEY, _v if _v in ('first_login', 'never') else 'always')
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": str(getattr(tenant, OTP_MODE_KEY, 'always') or 'always'), "type": "string"}

    if canonical_key == CAPTCHA_MODE_KEY:
        tenant = _get_master_tenant(request, master_db)
        captcha_mode = _normalize_captcha_mode_value(data.value)
        setattr(tenant, CAPTCHA_MODE_KEY, captcha_mode)
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": captcha_mode, "type": "string"}

    if canonical_key == SMTP_HOST_KEY:
        tenant = _get_master_tenant(request, master_db)
        tenant.smtp_host = _clean_nullable_string(data.value)
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _get_tenant_smtp_host_value(tenant), "type": "string"}

    if canonical_key == SMTP_PORT_KEY:
        tenant = _get_master_tenant(request, master_db)
        tenant.smtp_port = _normalize_smtp_port_value(data.value)
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _get_tenant_smtp_port_value(tenant), "type": "string"}

    if canonical_key == SMTP_USER_KEY:
        tenant = _get_master_tenant(request, master_db)
        _apply_tenant_smtp_user(tenant, data.value)
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _get_tenant_smtp_user_value(tenant), "type": "string"}

    if canonical_key == MAIL_KEY:
        tenant = _get_master_tenant(request, master_db)
        _apply_tenant_mail(tenant, data.value)
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": _get_tenant_mail_value(tenant), "type": "string"}

    if canonical_key == SMTP_PASSWORD_KEY:
        _delete_setting(db, canonical_key)
        password = _serialize_value(data.value)
        if password.strip():
            tenant = _get_master_tenant(request, master_db)
            tenant.smtp_password = password
            master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": "", "type": "password"}

    if canonical_key == SMTP_SECURITY_KEY:
        tenant = _get_master_tenant(request, master_db)
        security = _apply_tenant_smtp_security(tenant, data.value)
        _delete_setting(db, canonical_key)
        master_db.commit()
        db.commit()
        return {"key": canonical_key, "value": security, "type": "string"}

    value_type = DEFAULTS.get(canonical_key, {}).get("type", "string")
    value = _serialize_value(data.value)

    _ensure_table(db)
    _upsert(db, canonical_key, value, value_type)
    db.commit()
    return {"key": canonical_key, "value": value, "type": value_type}


@router.post("/company/logo", response_model=ThemeLogoResponse)
async def upload_company_logo(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    _: User = Depends(get_current_user),
):
    invalidate_theme_cache(db)
    if not file.filename:
        raise HTTPException(status_code=400, detail="Logo file is required")

    suffix = Path(file.filename).suffix.lower()
    if not suffix:
        suffix = CONTENT_TYPE_EXTENSIONS.get((file.content_type or "").lower(), "")
    if suffix not in ALLOWED_LOGO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported logo file type")

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded logo is empty")

    max_bytes = max(1, settings.MAX_UPLOAD_SIZE_MB) * 1024 * 1024
    if len(contents) > max_bytes:
        raise HTTPException(status_code=400, detail=f"Logo exceeds {settings.MAX_UPLOAD_SIZE_MB} MB limit")

    try:
        _ensure_table(db)
        tenant = _get_master_tenant(request, master_db)

        upload_dir = _uploads_root() / "tenant_settings" / tenant.slug
        upload_dir.mkdir(parents=True, exist_ok=True)

        existing_row = _get_setting_row(db, LOGO_SETTING_KEY)
        existing_path = existing_row.value if existing_row else ""
        existing_file = _resolve_upload_file(existing_path)
        existing_size = existing_file.stat().st_size if existing_file and existing_file.exists() else 0
        ensure_tenant_storage_available(tenant.slug, max(0, len(contents) - existing_size))
        if existing_file and existing_file.exists() and existing_file.suffix.lower() != suffix:
            existing_file.unlink()

        target_path = upload_dir / f"{LOGO_SETTING_KEY}{suffix}"
        target_path.write_bytes(contents)
        refresh_tenant_storage_usage_for_slug(tenant.slug)

        web_path = f"/uploads/tenant_settings/{tenant.slug}/{LOGO_SETTING_KEY}{suffix}"
        _upsert(db, LOGO_SETTING_KEY, web_path, "string")
        db.commit()

        saved_row = _get_setting_row(db, LOGO_SETTING_KEY)
        version = _logo_version(web_path, saved_row.updated_at if saved_row else None)
        return {
            "theme_logo": web_path,
            "theme_logo_version": version,
            "company_logo": web_path,
            "logo_url": web_path,
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("upload_company_logo failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to upload company logo") from exc


@router.delete("/company/logo", response_model=DeleteThemeLogoResponse)
def delete_company_logo(
    request: Request,
    delete_file: bool = Query(True),
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    _: User = Depends(get_current_user),
):
    invalidate_theme_cache(db)
    try:
        _ensure_table(db)
        _get_master_tenant(request, master_db)

        row = _get_setting_row(db, LOGO_SETTING_KEY)
        existing_path = row.value if row else ""
        deleted_file = False

        if delete_file:
            existing_file = _resolve_upload_file(existing_path)
            if existing_file and existing_file.exists():
                existing_file.unlink()
                deleted_file = True

        _delete_setting(db, LOGO_SETTING_KEY)
        db.commit()
        return {"status": "deleted", "deleted_file": deleted_file}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("delete_company_logo failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to delete company logo") from exc


@router.post("/company/letter-pad-seal")
async def upload_letter_pad_seal(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    _: User = Depends(get_current_user),
):
    invalidate_theme_cache(db)
    if not file.filename:
        raise HTTPException(status_code=400, detail="Seal image is required")
    suffix = Path(file.filename).suffix.lower() or CONTENT_TYPE_EXTENSIONS.get((file.content_type or "").lower(), "")
    if suffix not in ALLOWED_LOGO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported seal image type")
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded seal image is empty")
    if len(contents) > max(1, settings.MAX_UPLOAD_SIZE_MB) * 1024 * 1024:
        raise HTTPException(status_code=400, detail=f"Seal image exceeds {settings.MAX_UPLOAD_SIZE_MB} MB limit")
    try:
        _ensure_table(db)
        tenant = _get_master_tenant(request, master_db)
        upload_dir = _uploads_root() / "tenant_settings" / tenant.slug
        upload_dir.mkdir(parents=True, exist_ok=True)
        existing_row = _get_setting_row(db, LETTER_PAD_SEAL_SETTING_KEY)
        existing_file = _resolve_upload_file(existing_row.value if existing_row else "")
        existing_size = existing_file.stat().st_size if existing_file and existing_file.exists() else 0
        ensure_tenant_storage_available(tenant.slug, max(0, len(contents) - existing_size))
        if existing_file and existing_file.exists() and existing_file.suffix.lower() != suffix:
            existing_file.unlink()
        target_path = upload_dir / f"{LETTER_PAD_SEAL_SETTING_KEY}{suffix}"
        target_path.write_bytes(contents)
        refresh_tenant_storage_usage_for_slug(tenant.slug)
        web_path = f"/uploads/tenant_settings/{tenant.slug}/{LETTER_PAD_SEAL_SETTING_KEY}{suffix}"
        _upsert(db, LETTER_PAD_SEAL_SETTING_KEY, web_path, "string")
        db.commit()
        return {"letter_pad_seal": web_path}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("upload_letter_pad_seal failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to upload letter pad seal") from exc


@router.delete("/company/letter-pad-seal")
def delete_letter_pad_seal(
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    _: User = Depends(get_current_user),
):
    invalidate_theme_cache(db)
    try:
        _ensure_table(db)
        tenant = _get_master_tenant(request, master_db)
        row = _get_setting_row(db, LETTER_PAD_SEAL_SETTING_KEY)
        file_path = _resolve_upload_file(row.value if row else "")
        if file_path and file_path.exists():
            file_path.unlink()
        _delete_setting(db, LETTER_PAD_SEAL_SETTING_KEY)
        db.commit()
        refresh_tenant_storage_usage_for_slug(tenant.slug)
        return {"status": "deleted"}
    except Exception as exc:
        db.rollback()
        logger.exception("delete_letter_pad_seal failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to delete letter pad seal") from exc


@router.get("/dashboard/preferences")
def get_dashboard_preferences(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    try:
        pref = db.query(DashboardPreference).filter(DashboardPreference.user_id == cu.id).first()
    except Exception:
        pref = None

    if not pref:
        return {"widgets": []}
    return {"widgets": pref.widgets or []}


@router.put("/dashboard/preferences")
def update_dashboard_preferences(
    data: DashboardPreferenceUpdate,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    widgets_data = [w.model_dump() for w in data.widgets]
    try:
        pref = db.query(DashboardPreference).filter(DashboardPreference.user_id == cu.id).first()
        if pref:
            pref.widgets = widgets_data
        else:
            pref = DashboardPreference(user_id=cu.id, widgets=widgets_data)
            db.add(pref)
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error("save dashboard preferences failed: %s", exc)
    return {"message": "saved", "widgets": widgets_data}

