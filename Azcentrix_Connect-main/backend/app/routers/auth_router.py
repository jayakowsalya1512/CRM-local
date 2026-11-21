"""Authentication router - login, refresh, logout, user management.

Changes vs previous version:
  - Added 'vp' to VALID_ROLES and ADMIN_ROLES
  - zone_id / zone_group_roles -> region_id / region_group_roles
  - UserCreate / UserUpdate / UserResponse include state_id + target field (Numeric)
  - TARGET_ROLES = all except admin and ceo
  - CUSTOMER_ASSIGN_ROLES = all except admin and ceo
  - AUTO_MANAGER_ROLES: reporting_manager auto-resolved from group.manager_id
  - MANUAL_MANAGER_ROLES: reporting_manager manually selected (manager / vp)
  - _resolve_reporting_manager() helper centralises the auto vs manual logic
  - Removed 'region' free-text field from UserCreate / UserUpdate / UserResponse
  - list_users now resolves region_name + group_name for the frontend table
  - Exclusive customer assignment keeps each customer assigned to only one user.
"""
import logging
import hmac
import secrets
import unicodedata
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import inspect, or_, text
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr, Field, field_validator
from typing import Optional, List, Any, Dict
from decimal import Decimal
from app.dependencies import (
    get_master_db_dep,
    get_tenant_db,
    get_current_user,
    get_request_ip,
    _resolve_tenant_slug,
    ensure_token_session_is_active,
    touch_user_session_activity,
    _istnow_naive,
)
from app.core.config import settings

from app.models.tenant import PlatformSetting, Tenant
from app.models.user import LoginAttempt
from app.models.all_models import (
    LoginOTPChallenge, User, UserSession,
    Role, Permission, RolePermission,
    Customer, SalesCustomerAssignment,
    Group, Region, KAMTarget, UserReportingHierarchy, OrgTreeNode,
    TrustedDevice, QuickPinCredential,
)
from app.core.security import (
    hash_password, verify_password,
    create_access_token, create_refresh_token,
    verify_token, hash_token,
    validate_password_strength,
    hash_device_uuid, create_trusted_device_token, verify_trusted_device_token,
    create_quick_pin_setup_token, verify_quick_pin_setup_token,
    TRUSTED_DEVICE_EXPIRE_DAYS,
)
from app.middleware.login_guard import (
    record_failed_attempt, is_locked_out, requires_captcha,
    reset_attempts, get_remaining_lockout, get_attempt_count,
)
from app.core.logging import log_auth_event, log_audit, log_audit_db, log_module_action, model_snapshot, parse_user_agent
from app.services.auth_policy_service import (
    build_session_policy_payload,
    get_access_token_expiry_minutes,
    get_login_expiry_minutes,
)
from app.services.password_reset_service import (
    assign_forgot_password_attempt_tenant,
    CONTACT_ADMIN_SUCCESS_MESSAGE,
    FORGOT_PASSWORD_GENERIC_SUCCESS_MESSAGE,
    PASSWORD_EXPIRED_MESSAGE,
    PasswordResetError,
    evaluate_password_change_requirement,
    protect_forgot_password_send_attempt,
    request_password_reset,
    reset_password_with_token,
    send_admin_password_changed_notification,
    send_admin_password_reset_link,
    send_contact_administrator_request,
    should_mask_forgot_password_error,
)
from app.services.tenant_email_service import (
    TenantEmailConfigurationError,
    TenantEmailDeliveryError,
    send_tenant_email,
)
from app.database import get_tenant_session_by_db_name
from app.services.push_notification_service import register_push_token
from app.services.user_group_service import (
    get_effective_user_group_ids,
    parse_user_group_ids,
)
from datetime import datetime, timedelta, timezone
from app.core.timezone import aware_now_ist, now_ist, today_ist

logger = logging.getLogger(__name__)
router = APIRouter()
LOGIN_OTP_EXPIRY_MINUTES = 10
LOGIN_OTP_MAX_ATTEMPTS = 5
LOGIN_OTP_LENGTH = 6


@router.get("/maintenance-status")
def maintenance_status(request: Request, master_db: Session = Depends(get_master_db_dep)):
    """Public platform-wide maintenance status used by all tenant clients."""
    setting = master_db.query(PlatformSetting).filter(PlatformSetting.key == "global_maintenance_mode").first()
    return {"maintenance_mode": bool(setting.value_bool) if setting else False}
QUICK_PIN_LENGTH = 4
QUICK_PIN_MAX_ATTEMPTS = 5
QUICK_PIN_LOCK_MINUTES = 30
TRUSTED_DEVICE_COOKIE_PREFIX = "td_"
CAPTCHA_MODE_AFTER_FAILED = "after_failed"
CAPTCHA_MODE_ALWAYS = "always"
CAPTCHA_MODE_NEVER = "never"
CAPTCHA_MODES = {CAPTCHA_MODE_AFTER_FAILED, CAPTCHA_MODE_ALWAYS, CAPTCHA_MODE_NEVER}

# --- Role constants -----------------------------------------------------------

# Roles that can manage/create users
ADMIN_ROLES = ['admin', 'ceo', 'manager']

# Roles that get region + state + group fields
REGION_GROUP_ROLES = ['sales', 'manager', 'vp']

# Roles that have a sales target (everyone except admin and ceo)
TARGET_ROLES = ['vp', 'manager', 'sales', 'support', 'accounts']

# Roles eligible for customer assignment (everyone except admin and ceo)
CUSTOMER_ASSIGN_ROLES = ['vp', 'manager', 'sales', 'support', 'accounts']

# Roles whose reporting_manager_id is auto-derived from their group's manager_id
AUTO_MANAGER_ROLES = ['sales', 'support', 'accounts']

# Roles whose reporting_manager_id is manually selected
MANUAL_MANAGER_ROLES = ['manager', 'vp']
RAW_USER_AGENT_MARKERS = ('Mozilla/', 'AppleWebKit/', 'Chrome/', 'Safari/', 'Edg/', 'Firefox/', 'OPR/', 'Trident/')


def _normalize_login_device_label(user_agent: str) -> str:
    raw = (user_agent or '').strip()
    if not raw:
        return 'Unknown device'
    if any(marker in raw for marker in RAW_USER_AGENT_MARKERS):
        return parse_user_agent(raw).replace('Â·', ' - ').replace('·', ' - ').strip()
    return raw.replace('Â·', ' - ').replace('·', ' - ').strip()


def _is_secure_request(request: Request) -> bool:
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",", 1)[0].strip().lower()
    if forwarded_proto:
        return forwarded_proto in {"https", "wss"}

    forwarded_ssl = (request.headers.get("x-forwarded-ssl") or "").strip().lower()
    if forwarded_ssl in {"on", "1", "true"}:
        return True

    return request.url.scheme == "https"


def _trusted_device_cookie_kwargs(request: Request) -> Dict[str, Any]:
    return {
        "path": "/",
        "httponly": True,
        "secure": _is_secure_request(request),
        "samesite": "strict",
    }


def _should_send_new_device_login_alert(
    db: Session,
    tenant: Tenant,
    user: User,
    device_label: str,
) -> bool:
    if not getattr(tenant, 'new_device_login_alert_enabled', False):
        return False
    if not (getattr(user, 'email', None) or '').strip():
        return False

    known_device_rows = (
        db.query(LoginAttempt.user_agent)
        .filter(LoginAttempt.username == user.username, LoginAttempt.success == True)
        .order_by(LoginAttempt.created_at.desc())
        .limit(50)
        .all()
    )
    known_devices = {
        _normalize_login_device_label(device_row[0] or '')
        for device_row in known_device_rows
        if (device_row[0] or '').strip()
    }
    return bool(known_devices) and device_label not in known_devices


def _send_new_device_login_alert(tenant: Tenant, user: User, device_label: str, ip_address: str) -> None:
    if not (getattr(user, 'email', None) or '').strip():
        return

    timestamp = now_ist().strftime('%Y-%m-%d %H:%M IST')
    display_name = user.full_name or user.username or 'User'
    tenant_name = tenant.name or tenant.slug or 'your company'
    text_body = (
        f"Hello {display_name},\n\n"
        f"We noticed a login to your {tenant_name} account from a new device.\n\n"
        f"Device: {device_label}\n"
        f"IP Address: {ip_address or 'Unavailable'}\n"
        f"Time: {timestamp}\n\n"
        "If this was you, no action is needed.\n"
        "If this was not you, please contact your administrator and change your password immediately."
    )
    html_body = f"""
    <html>
      <body style="font-family: Arial, sans-serif; color: #0f172a;">
        <p>Hello {display_name},</p>
        <p>We noticed a login to your <strong>{tenant_name}</strong> account from a new device.</p>
        <ul>
          <li><strong>Device:</strong> {device_label}</li>
          <li><strong>IP Address:</strong> {ip_address or 'Unavailable'}</li>
          <li><strong>Time:</strong> {timestamp}</li>
        </ul>
        <p>If this was you, no action is needed.</p>
        <p>If this was not you, please contact your administrator and change your password immediately.</p>
      </body>
    </html>
    """

    try:
        send_tenant_email(
            tenant=tenant,
            to_email=user.email,
            subject='New device login detected',
            text_body=text_body,
            html_body=html_body,
        )
    except (TenantEmailConfigurationError, TenantEmailDeliveryError) as exc:
        logger.warning(
            'New device login alert failed for tenant=%s user=%s: %s',
            tenant.slug,
            user.id,
            exc,
        )
    except Exception as exc:
        logger.warning(
            'Unexpected new device login alert failure for tenant=%s user=%s: %s',
            tenant.slug,
            user.id,
            exc,
        )


def _split_device_label(device_label: str) -> tuple[str, str]:
    parts = [part.strip() for part in (device_label or "").replace('Â·', ' - ').replace('·', ' - ').split(' - ', 1)]
    browser = parts[0] if parts and parts[0] else "Unknown browser"
    os_name = parts[1] if len(parts) > 1 and parts[1] else "Unknown OS"
    return browser, os_name


def _get_request_access_payload(request: Request) -> Optional[dict]:
    authorization = request.headers.get("authorization", "").strip()
    if not authorization.lower().startswith("bearer "):
        return None
    token = authorization[7:].strip()
    if not token:
        return None
    return verify_token(token, "access")


def _get_request_session_jti(request: Request) -> Optional[str]:
    payload = _get_request_access_payload(request) or {}
    session_jti = str(payload.get("session_jti") or "").strip()
    return session_jti or None


def _revoke_user_sessions(
    db: Session,
    user_ids: List[int],
    *,
    revoked_by_user_id: Optional[int],
    revoke_reason: str,
    revoke_scope: str,
    session_jti: Optional[str] = None,
    exclude_session_jti: Optional[str] = None,
) -> int:
    normalized_user_ids = [user_id for user_id in {int(user_id) for user_id in user_ids if user_id}]
    if not normalized_user_ids:
        return 0

    if session_jti and exclude_session_jti:
        raise ValueError("Provide either session_jti or exclude_session_jti, not both")

    query = db.query(UserSession).filter(
        UserSession.user_id.in_(normalized_user_ids),
        UserSession.is_active == True,
    )
    if session_jti:
        query = query.filter(UserSession.session_jti == session_jti)
    elif exclude_session_jti:
        query = query.filter(
            or_(
                UserSession.session_jti.is_(None),
                UserSession.session_jti != exclude_session_jti,
            )
        )

    revoked_at = _istnow_naive()
    session_rows = query.all()
    for session_row in session_rows:
        session_row.is_active = False
        session_row.logout_time = revoked_at
        session_row.revoked_at = revoked_at
        session_row.revoked_by_user_id = revoked_by_user_id
        session_row.revoke_reason = revoke_reason[:255]
        session_row.revoke_scope = revoke_scope[:20]
    return len(session_rows)


def _normalize_captcha_mode(raw_value: Any) -> str:
    value = str(raw_value or "").strip()
    return value if value in CAPTCHA_MODES else CAPTCHA_MODE_AFTER_FAILED


def _login_requires_captcha(tenant_slug: str, username: str, captcha_mode: str) -> bool:
    normalized_mode = _normalize_captcha_mode(captcha_mode)
    if normalized_mode == CAPTCHA_MODE_ALWAYS:
        return True
    if normalized_mode == CAPTCHA_MODE_NEVER:
        return False
    return requires_captcha(tenant_slug, username)


# --- Schemas ------------------------------------------------------------------

class LoginRequest(BaseModel):
    username:      str
    password:      str
    remember_me:   bool = True
    captcha_token: Optional[str] = None
    fcm_token:     Optional[str] = Field(default=None, max_length=512)
    login_from:    Optional[str] = Field(default="web")  # "web" | "mobile"


class LoginResponse(BaseModel):
    access_token:  Optional[str] = None
    refresh_token: Optional[str] = None
    token_type:    str = "bearer"
    user_id:       Optional[int] = None
    username:      Optional[str] = None
    full_name:     Optional[str] = None
    role:          Optional[str] = None
    permissions:   List[str] = []
    password_expired: bool = False
    must_change_password: bool = False
    password_reset_token: Optional[str] = None
    message: Optional[str] = None
    otp_required: bool = False
    otp_challenge_id: Optional[str] = None
    otp_expires_in_seconds: Optional[int] = None
    otp_delivery_target: Optional[str] = None
    login_expiry_minutes: Optional[int] = None

    # Branding included on auth responses
    company_logo: Optional[str] = None       # stored path from settings
    company_logo_url: Optional[str] = None   # full URL for clients


class RefreshRequest(BaseModel):
    refresh_token: str


class VerifyLoginOtpRequest(BaseModel):
    challenge_id: str
    otp: str


class ResendLoginOtpRequest(BaseModel):
    challenge_id: str


class MobileOrgInfoResponse(BaseModel):
    org_name: str
    slug: str
    subdomain: str
    org_logo_url: Optional[str] = None


class QuickPinVerifyAccountRequest(BaseModel):
    """Step 1 — identify employee; sends OTP to their registered email."""
    username: str
    email: Optional[str] = None
    employee_code: Optional[str] = None
    emp_id: Optional[int] = None


class QuickPinVerifyAccountResponse(BaseModel):
    """Returned after identity check — OTP has been sent to email."""
    challenge_id: str
    user_id: int
    username: str
    full_name: str
    company_code: str
    otp_expires_in_seconds: int = 600
    otp_delivery_target: str


class QuickPinVerifyOtpRequest(BaseModel):
    """Step 2 — verify OTP; receive setup_token to create the PIN."""
    challenge_id: str
    otp: str


class QuickPinSetupTokenResponse(BaseModel):
    """Returned after OTP passes — use setup_token with /quick-pin/set."""
    setup_token: str
    user_id: int
    username: str
    full_name: str
    company_code: str
    expires_in_seconds: int = 600


class QuickPinSetRequest(BaseModel):
    setup_token: str
    pin: str
    confirm_pin: str


class QuickPinLoginRequest(BaseModel):
    """Step 4 — daily PIN login on mobile."""
    employee_code: str
    pin: str
    remember_me: bool = True
    fcm_token: Optional[str] = Field(default=None, max_length=512)


class ForgotPasswordRequest(BaseModel):
    email: EmailStr
    employee_code: Optional[str] = None


class ForgotPasswordResetPayload(BaseModel):
    token: Optional[str] = None
    new_password: Optional[str] = None
    confirm_password: Optional[str] = None


class ContactAdministratorRequest(BaseModel):
    email: Optional[EmailStr] = None
    tenant_slug: Optional[str] = None
    username: Optional[str] = None


class BulkUserLogoutPayload(BaseModel):
    user_ids: List[int]
    require_password_reset: bool = False


class TenantForceLogoutPayload(BaseModel):
    require_password_reset: bool = False


class CaptchaStatusResponse(BaseModel):
    requires_captcha:  bool
    is_locked:         bool
    remaining_seconds: int
    attempts:          int


class LogoutHistoryEventResponse(BaseModel):
    revoked_at: datetime
    revoked_by_user_id: Optional[int] = None
    revoked_by_name: Optional[str] = None
    revoke_scope: Optional[str] = None
    revoke_reason: Optional[str] = None
    session_count: int = 0
    devices: List[str] = []
    forced_by_other_user: bool = False


def _normalize_user_phone(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    raw = v.strip()
    if not raw:
        return None
    digits = ''.join(ch for ch in raw if ch.isdigit())
    if len(digits) != 10:
        raise ValueError("Mobile number must be exactly 10 digits")
    return digits


class UserCreate(BaseModel):
    username:              str
    email:                 EmailStr
    full_name:             str
    password:              str
    confirm_password:      Optional[str]       = None
    role:                  str                 = "sales"
    department:            Optional[str]       = None
    designation:           Optional[str]       = None
    phone:                 Optional[str]       = None
    branch:                Optional[str]       = None
    employee_code:         Optional[str]       = None
    reporting_manager_id:  Optional[int]       = None
    reporting_manager_ids: Optional[List[int]] = None
    region_id: Optional[int] = None
    state_id: Optional[int] = None
    group_id:              Optional[int]       = None
    target:                Optional[Decimal]   = None

    @field_validator('phone')
    @classmethod
    def validate_phone(cls, v: Optional[str]) -> Optional[str]:
        return _normalize_user_phone(v)


class UserGroupHierarchySummary(BaseModel):
    reporting_user_id: Optional[int] = None
    reporting_role: str
    level: int
    user_name: Optional[str] = None


class UserGroupSummary(BaseModel):
    id: int
    name: str
    reporting_hierarchy: List[UserGroupHierarchySummary] = Field(default_factory=list)


class UserResponse(BaseModel):
    id:                    int
    username:              str
    email:                 str
    full_name:             str
    role:                  str
    department:            Optional[str]
    designation:           Optional[str]
    phone:                 Optional[str]
    branch:                Optional[str]
    employee_code:         Optional[str]
    reporting_manager_id:  Optional[int]
    reporting_manager_ids: List[int] = []
    region_id: Optional[int] = None
    state_id: Optional[int] = None
    group_id:              Optional[int]
    group_ids:             List[int] = []
    group_name:            Optional[str] = None
    groups:                List[UserGroupSummary] = []
    target:                Optional[Decimal]
    last_login:            Optional[datetime] = None
    is_active:             bool

    model_config = {"from_attributes": True}


# Extended response used only for list_users; includes resolved display names
class UserListResponse(UserResponse):
    region_name: Optional[str] = None
    group_name:  Optional[str] = None


class UserUpdate(BaseModel):
    email:                 Optional[EmailStr] = None
    full_name:             Optional[str]      = None
    role:                  Optional[str]      = None
    department:            Optional[str]      = None
    designation:           Optional[str]      = None
    phone:                 Optional[str]      = None
    branch:                Optional[str]      = None
    employee_code:         Optional[str]      = None
    reporting_manager_id:  Optional[int]      = None
    reporting_manager_ids: Optional[List[int]] = None
    region_id: Optional[int] = None
    state_id: Optional[int] = None
    group_id:              Optional[int]      = None
    target:                Optional[Decimal]  = None
    is_active:             Optional[bool]     = None
    password:              Optional[str]      = None

    @field_validator('phone')
    @classmethod
    def validate_phone(cls, v: Optional[str]) -> Optional[str]:
        return _normalize_user_phone(v)


class ResetPasswordPayload(BaseModel):
    new_password: str
    confirm_password: Optional[str] = None


class CustomerAssignPayload(BaseModel):
    customer_ids: List[int]


class CustomerAssignResponse(BaseModel):
    id:                  int
    customer_name:       Optional[str] = None
    customer_vertical:   Optional[str] = None
    division:            Optional[str] = None

    model_config = {"from_attributes": True}


# --- Helper: resolve permissions from DB --------------------------------------

def get_role_permissions_from_db(db: Session, role_name: str) -> List[str]:
    try:
        role_row = db.query(Role).filter(
            Role.name == role_name,
            Role.is_active == True,
        ).first()
        if not role_row:
            return []
        perm_ids = [
            rp.permission_id
            for rp in db.query(RolePermission).filter(
                RolePermission.role_id == role_row.id
            ).all()
        ]
        if not perm_ids:
            return []
        return [
            p.key
            for p in db.query(Permission).filter(
                Permission.id.in_(perm_ids)
            ).all()
        ]
    except Exception as e:
        logger.warning(f"get_role_permissions_from_db failed for {role_name}: {e}")
        return []


# --- Helper: resolve reporting manager ----------------------------------------

def _resolve_reporting_manager(
    role:                 str,
    reporting_manager_id: Optional[int],
) -> Optional[int]:
    if role in ('admin', 'ceo'):
        return None
    return reporting_manager_id

def _parse_ids(value):
    if not value:
        return []
    return [
        int(x.strip())
        for x in str(value).split(",")
        if x.strip().isdigit()
    ]

def _parse_single_int(value) -> Optional[int]:
    """Coerce empty-string or comma-separated DB values to a single Optional[int]."""
    ids = _parse_ids(value)
    return ids[0] if ids else None

def _parse_user_group_ids(value: Any) -> List[int]:
    return parse_user_group_ids(value)


def _load_group_map(db: Session, group_ids: List[int]) -> Dict[int, str]:
    normalized_group_ids = sorted({int(group_id) for group_id in group_ids if group_id})
    if not normalized_group_ids:
        return {}
    groups = db.query(Group).filter(Group.id.in_(normalized_group_ids)).all()
    return {group.id: group.name for group in groups}


def _load_group_hierarchy_map(db: Session, group_ids: List[int]) -> Dict[int, List[Dict[str, Any]]]:
    normalized_group_ids = sorted({int(group_id) for group_id in group_ids if group_id})
    if not normalized_group_ids:
        return {}

    rows = (
        db.query(UserReportingHierarchy)
        .filter(
            UserReportingHierarchy.group_id.in_(normalized_group_ids),
            UserReportingHierarchy.is_active == True,
        )
        .order_by(
            UserReportingHierarchy.group_id.asc(),
            UserReportingHierarchy.level.asc(),
            UserReportingHierarchy.id.asc(),
        )
        .all()
    )
    user_ids = sorted({int(row.reporting_user_id) for row in rows if row.reporting_user_id})
    users = db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []
    user_name_map = {
        user.id: (user.full_name or user.username or f"User #{user.id}")
        for user in users
    }

    hierarchy_map: Dict[int, List[Dict[str, Any]]] = {}
    for row in rows:
        group_id = int(row.group_id) if row.group_id else None
        if not group_id:
            continue
        hierarchy_map.setdefault(group_id, []).append({
            "reporting_user_id": row.reporting_user_id,
            "reporting_role": row.reporting_role,
            "level": row.level,
            "user_name": user_name_map.get(row.reporting_user_id),
        })
    return hierarchy_map


def _load_org_tree_groups_by_user(db: Session, user_ids: List[int]) -> Dict[int, List[Dict[str, Any]]]:
    """Resolve user group memberships from Masters > Groups (Group Fixing)."""
    normalized_user_ids = sorted({int(user_id) for user_id in user_ids if user_id})
    if not normalized_user_ids:
        return {}

    try:
        group_nodes = (
            db.query(OrgTreeNode)
            .filter(
                OrgTreeNode.is_active == True,
                OrgTreeNode.level == 2,
                OrgTreeNode.group_name.isnot(None),
            )
            .order_by(OrgTreeNode.position.asc(), OrgTreeNode.id.asc())
            .all()
        )

        def group_key(group_name: Any, group_lead_id: Any) -> tuple[str, Optional[int]]:
            name = str(group_name or "").strip().lower()
            try:
                lead_id = int(group_lead_id) if group_lead_id else None
            except (TypeError, ValueError):
                lead_id = None
            return name, lead_id

        group_id_by_key = {
            group_key(node.group_name, node.group_lead_id): int(node.id)
            for node in group_nodes
            if str(getattr(node, "group_name", "") or "").strip()
        }

        user_nodes = (
            db.query(OrgTreeNode)
            .filter(
                OrgTreeNode.is_active == True,
                OrgTreeNode.user_id.in_(normalized_user_ids),
                OrgTreeNode.group_name.isnot(None),
            )
            .order_by(OrgTreeNode.level.asc(), OrgTreeNode.position.asc(), OrgTreeNode.id.asc())
            .all()
        )
    except Exception as exc:
        logger.warning("Failed to resolve org-tree groups for user list: %s", exc)
        return {}

    groups_by_user: Dict[int, List[Dict[str, Any]]] = {}
    seen: set[tuple[int, int, str]] = set()
    for node in user_nodes:
        user_id = int(node.user_id) if node.user_id else None
        group_name = str(getattr(node, "group_name", "") or "").strip()
        if not user_id or not group_name:
            continue

        group_id = group_id_by_key.get(group_key(group_name, getattr(node, "group_lead_id", None)))
        if not group_id:
            group_id = int(node.id) if int(getattr(node, "level", 0) or 0) == 2 else int(node.parent_id or node.id)

        dedupe_key = (user_id, group_id, group_name.lower())
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        groups_by_user.setdefault(user_id, []).append({
            "id": group_id,
            "name": group_name,
            "reporting_hierarchy": [],
        })

    return groups_by_user


def _serialize_user_response(
    user: User,
    db: Session,
    *,
    group_map: Optional[Dict[int, str]] = None,
    include_effective_groups: bool = False,
) -> Dict[str, Any]:
    user_group_ids = (
        get_effective_user_group_ids(user, db)
        if include_effective_groups
        else _parse_user_group_ids(getattr(user, "group_id", None))
    )
    resolved_group_map = group_map or _load_group_map(db, user_group_ids)
    hierarchy_map = _load_group_hierarchy_map(db, user_group_ids)
    groups = [
        {
            "id": group_id,
            "name": resolved_group_map[group_id],
            "reporting_hierarchy": hierarchy_map.get(group_id, []),
        }
        for group_id in user_group_ids
        if group_id in resolved_group_map
    ]
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "full_name": user.full_name,
        "role": user.role,
        "department": user.department,
        "designation": user.designation,
        "phone": user.phone,
        "branch": user.branch,
        "employee_code": user.employee_code,
        "reporting_manager_id": user.reporting_manager_id,
        "reporting_manager_ids": user.reporting_manager_ids if isinstance(user.reporting_manager_ids, list) else [],
        "region_id": _parse_single_int(user.region_id),
        "state_id": _parse_single_int(user.state_id),
        "group_id": user_group_ids[0] if user_group_ids else None,
        "group_ids": user_group_ids,
        "group_name": ", ".join(groups_row["name"] for groups_row in groups) if groups else None,
        "groups": groups,
        "target": user.target,
        "last_login": user.last_login,
        "is_active": bool(user.is_active),
    }


# --- Helper: enrich users with region_name + group_name ----------------------

def _enrich_users(users: List[User], db: Session) -> List[Dict[str, Any]]:
    """
    Bulk-resolve display fields for a list of users.
    Masters > Groups (Group Fixing) is preferred for group memberships, with
    the legacy users.group_id value kept as a fallback.
    """
    user_ids = [u.id for u in users if u.id]
    region_ids = {_parse_single_int(u.region_id) for u in users if u.region_id} - {None}
    group_ids = {
        group_id
        for u in users
        for group_id in _parse_user_group_ids(u.group_id)
    }

    region_map: Dict[int, str] = {}
    group_map:  Dict[int, str] = {}
    org_tree_groups_by_user: Dict[int, List[Dict[str, Any]]] = {}
    latest_kam_target_map: Dict[int, Optional[Decimal]] = {}

    if region_ids:
        regions = db.query(Region).filter(Region.id.in_(region_ids)).all()
        region_map = {r.id: r.name for r in regions}

    if group_ids:
        groups = db.query(Group).filter(Group.id.in_(group_ids)).all()
        group_map = {g.id: g.name for g in groups}

    if user_ids:
        org_tree_groups_by_user = _load_org_tree_groups_by_user(db, user_ids)

        kam_targets = db.query(KAMTarget).filter(
            KAMTarget.user_id.in_(user_ids),
        ).order_by(
            KAMTarget.user_id.asc(),
            KAMTarget.period.desc(),
            KAMTarget.created_at.desc(),
            KAMTarget.id.desc(),
        ).all()

        for target in kam_targets:
            if target.user_id in latest_kam_target_map:
                continue
            sales_target = getattr(target, "sales_target", None)
            latest_kam_target_map[target.user_id] = sales_target if sales_target else None

    result = []
    for u in users:
        d = _serialize_user_response(u, db, group_map=group_map)
        org_tree_groups = org_tree_groups_by_user.get(int(u.id), []) if u.id else []
        if org_tree_groups:
            org_tree_group_ids = [int(group["id"]) for group in org_tree_groups if group.get("id")]
            d["group_id"] = org_tree_group_ids[0] if org_tree_group_ids else None
            d["group_ids"] = org_tree_group_ids
            d["group_name"] = ", ".join(group["name"] for group in org_tree_groups if group.get("name")) or None
            d["groups"] = org_tree_groups
        if d.get("target") is None and u.id in latest_kam_target_map:
            d["target"] = latest_kam_target_map[u.id]
        d['region_name'] = region_map.get(_parse_single_int(u.region_id)) if u.region_id else None
        result.append(d)

    return result


# --- Guards -------------------------------------------------------------------

def _require_user_admin(cu: User):
    if cu.role not in ADMIN_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Super Admin, CEO, or Manager can manage users",
        )


def _get_assignable_user(user_id: int, db: Session, cu: User) -> User:
    """
    Fetch any user eligible for customer assignment.
    Managers can only manage their own direct reports.
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    if user.role not in CUSTOMER_ASSIGN_ROLES:
        raise HTTPException(400, f"Customer assignment is not available for role '{user.role}'")
    # if cu.role == 'manager' and user.reporting_manager_id != cu.id:
    #     raise HTTPException(403, "You can only manage your own team members")
    return user


def _effective_customer_owner_map(db: Session) -> Dict[int, int]:
    """Resolve customer ownership with assignment rows first, then customers.assigned_to fallback."""
    owner_map: Dict[int, int] = {}

    active_assignments = db.query(SalesCustomerAssignment).filter(
        SalesCustomerAssignment.is_active == True,
    ).all()
    for row in active_assignments:
        owner_map[int(row.customer_id)] = int(row.user_id)

    fallback_rows = db.query(Customer.id, Customer.assigned_to).filter(
        Customer.assigned_to.isnot(None),
    ).all()
    for row in fallback_rows:
        customer_id = int(row.id)
        if customer_id not in owner_map and row.assigned_to is not None:
            owner_map[customer_id] = int(row.assigned_to)

    return owner_map


def _utcnow_naive() -> datetime:
    return now_ist()


def _ensure_login_otp_schema(db: Session) -> None:
    bind = db.get_bind()
    LoginOTPChallenge.__table__.create(bind=bind, checkfirst=True)

    # Older deployments created this table before OTP hashes were finalized.
    # If the hash column is too short, MySQL may truncate writes and every
    # correct OTP will compare as invalid.
    if bind.dialect.name not in {"mysql", "mariadb"}:
        return

    try:
        columns = {
            column["name"]: column
            for column in inspect(bind).get_columns(LoginOTPChallenge.__tablename__)
        }
    except Exception:
        logger.exception("Unable to inspect login OTP challenge schema")
        return

    def _column_length(name: str) -> Optional[int]:
        column = columns.get(name)
        if not column:
            return None
        return getattr(column.get("type"), "length", None)

    statements: list[str] = []
    if _column_length("challenge_id") is not None and (_column_length("challenge_id") or 0) < 80:
        statements.append("MODIFY COLUMN challenge_id VARCHAR(80) NOT NULL")
    if _column_length("otp_hash") is not None and (_column_length("otp_hash") or 0) < 255:
        statements.append("MODIFY COLUMN otp_hash VARCHAR(255) NOT NULL")
    if "fcm_token" not in columns:
        statements.append("ADD COLUMN fcm_token VARCHAR(512) NULL")

    if not statements:
        return

    for statement in statements:
        db.execute(text(f"ALTER TABLE login_otp_challenges {statement}"))
    db.commit()


def _ensure_quick_pin_schema(db: Session) -> None:
    bind = db.get_bind()
    QuickPinCredential.__table__.create(bind=bind, checkfirst=True)

    if bind.dialect.name not in {"mysql", "mariadb"}:
        return

    try:
        columns = {
            column["name"]: column
            for column in inspect(bind).get_columns(QuickPinCredential.__tablename__)
        }
    except Exception:
        logger.exception("Unable to inspect quick PIN schema")
        return

    def _column_length(name: str) -> Optional[int]:
        column = columns.get(name)
        if not column:
            return None
        return getattr(column.get("type"), "length", None)

    statements: list[str] = []
    if _column_length("device_uuid_hash") is not None and (_column_length("device_uuid_hash") or 0) < 100:
        statements.append("MODIFY COLUMN device_uuid_hash VARCHAR(100) NOT NULL")
    if _column_length("pin_hash") is not None and (_column_length("pin_hash") or 0) < 255:
        statements.append("MODIFY COLUMN pin_hash VARCHAR(255) NOT NULL")

    for statement in statements:
        db.execute(text(f"ALTER TABLE quick_pin_credentials {statement}"))
    if statements:
        db.commit()


def _send_quick_pin_setup_otp_email(
    *,
    tenant: Tenant,
    user: User,
    otp_code: str,
    expiry_minutes: int,
) -> None:
    display_name = user.full_name or user.username or "User"
    tenant_name = tenant.name or tenant.slug or "your company"
    text_body = (
        f"Hello {display_name},\n\n"
        f"Your {tenant_name} Quick PIN setup verification code is: {otp_code}\n\n"
        f"This code expires in {expiry_minutes} minute(s).\n"
        "If you did not request this, please contact your administrator."
    )
    html_body = f"""
    <html>
      <body style="font-family: Arial, sans-serif; color: #0f172a;">
        <p>Hello {display_name},</p>
        <p>Use the code below to verify your identity and set up your <strong>{tenant_name}</strong> Quick PIN:</p>
        <p style="font-size: 30px; font-weight: 700; letter-spacing: 0.2em; margin: 20px 0; color: #1d4ed8;">{otp_code}</p>
        <p>This code expires in <strong>{expiry_minutes} minute(s)</strong>.</p>
        <p>If you did not request a Quick PIN setup, please contact your administrator immediately.</p>
      </body>
    </html>
    """
    send_tenant_email(
        tenant=tenant,
        to_email=user.email,
        subject="Quick PIN setup — verification code",
        text_body=text_body,
        html_body=html_body,
    )


def _normalize_quick_pin(pin: str) -> str:
    digits: list[str] = []
    for ch in str(pin or "").strip():
        try:
            digits.append(str(unicodedata.digit(ch)))
        except (TypeError, ValueError):
            continue
    return "".join(digits)


def _require_quick_pin(pin: str) -> str:
    normalized = _normalize_quick_pin(pin)
    if len(normalized) != QUICK_PIN_LENGTH:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Enter a 4-digit PIN.")
    return normalized


def _require_device_uuid(request: Request) -> str:
    device_uuid = (request.headers.get("X-Device-UUID") or "").strip()
    if not device_uuid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Device ID is required for Quick PIN.")
    return device_uuid


def _cleanup_stale_login_otp_challenges(db: Session) -> None:
    now = _utcnow_naive()
    db.query(LoginOTPChallenge).filter(
        or_(
            LoginOTPChallenge.expires_at < now,
            LoginOTPChallenge.consumed_at.is_not(None),
        )
    ).delete(synchronize_session=False)


def _generate_login_otp_code() -> str:
    digits = "0123456789"
    return "".join(secrets.choice(digits) for _ in range(LOGIN_OTP_LENGTH))


def _normalize_otp_code(value: str) -> str:
    digits: list[str] = []
    for ch in str(value or "").strip():
        try:
            digits.append(str(unicodedata.digit(ch)))
        except (TypeError, ValueError):
            continue
    return "".join(digits)


def _hash_login_otp(challenge_id: str, otp_code: str) -> str:
    return hash_token(f"{str(challenge_id or '').strip()}:{_normalize_otp_code(otp_code)}")


def _login_otp_matches(challenge: LoginOTPChallenge, normalized_otp: str) -> bool:
    stored_hash = str(challenge.otp_hash or "").strip()
    if not stored_hash:
        return False

    current_hash = _hash_login_otp(challenge.challenge_id, normalized_otp)
    if hmac.compare_digest(current_hash, stored_hash):
        return True

    # Backward compatibility for challenges created by earlier OTP builds.
    legacy_hashes = (
        hash_token(normalized_otp),
        hash_token(f"{str(challenge.challenge_id or '').strip()}{normalized_otp}"),
    )
    if any(hmac.compare_digest(legacy_hash, stored_hash) for legacy_hash in legacy_hashes):
        return True

    legacy_plain_otp = _normalize_otp_code(stored_hash)
    return (
        len(legacy_plain_otp) == LOGIN_OTP_LENGTH
        and hmac.compare_digest(legacy_plain_otp, normalized_otp)
    )


def _mask_email_address(email: str) -> str:
    normalized_email = (email or "").strip()
    if not normalized_email or "@" not in normalized_email:
        return normalized_email
    local_part, domain = normalized_email.split("@", 1)
    if len(local_part) <= 2:
        masked_local = f"{local_part[:1]}***"
    else:
        masked_local = f"{local_part[:2]}***"
    return f"{masked_local}@{domain}"


def _send_login_otp_email(
    *,
    tenant: Tenant,
    user: User,
    otp_code: str,
    expiry_minutes: int,
    device_label: str,
    ip_address: str,
) -> None:
    display_name = user.full_name or user.username or "User"
    tenant_name = tenant.name or tenant.slug or "your company"
    text_body = (
        f"Hello {display_name},\n\n"
        f"Your {tenant_name} login verification code is: {otp_code}\n\n"
        f"This code expires in {expiry_minutes} minute(s).\n"
        f"NOTE: This code supersedes any previous verification emails. Use only this latest code.\n\n"
        f"Device: {device_label or 'Unknown device'}\n"
        f"IP Address: {ip_address or 'Unavailable'}\n\n"
        "If you did not attempt to sign in, please contact your administrator."
    )
    html_body = f"""
    <html>
      <body style="font-family: Arial, sans-serif; color: #0f172a;">
        <p>Hello {display_name},</p>
        <p>Your <strong>{tenant_name}</strong> login verification code is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 0.18em; margin: 20px 0;">{otp_code}</p>
        <p>This code expires in {expiry_minutes} minute(s).</p>
        <p style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:8px 12px;font-size:13px;color:#92400e;">
          <strong>Note:</strong> This is your latest code. Any previous verification emails are now invalid; please use only this code.
        </p>
        <p><strong>Device:</strong> {device_label or 'Unknown device'}<br /><strong>IP Address:</strong> {ip_address or 'Unavailable'}</p>
        <p>If you did not attempt to sign in, please contact your administrator.</p>
      </body>
    </html>
    """
    send_tenant_email(
        tenant=tenant,
        to_email=user.email,
        subject="Your login verification code",
        text_body=text_body,
        html_body=html_body,
    )


def _build_login_otp_response(
    *,
    db: Session,
    request: Request,
    user: User,
    permissions: List[str],
    challenge_id: str,
    email: str,
    message: str,
) -> LoginResponse:
    company_logo = _get_company_logo_from_settings(db)
    return LoginResponse(
        user_id=user.id,
        username=user.username,
        full_name=user.full_name,
        role=user.role,
        permissions=permissions,
        message=message,
        otp_required=True,
        otp_challenge_id=challenge_id,
        otp_expires_in_seconds=LOGIN_OTP_EXPIRY_MINUTES * 60,
        otp_delivery_target=_mask_email_address(email),
        company_logo=company_logo,
company_logo_url=company_logo,    )


def _check_trusted_device(
    request: Request,
    db: Session,
    user_id: int,
    tenant_slug: str,
) -> "TrustedDevice | None":
    device_uuid = (request.headers.get("X-Device-UUID") or "").strip()
    if not device_uuid:
        return None
    cookie_token = request.cookies.get(f"{TRUSTED_DEVICE_COOKIE_PREFIX}{tenant_slug}", "")
    if not cookie_token:
        return None
    payload = verify_trusted_device_token(cookie_token)
    if not payload or payload.get("user_id") != user_id or payload.get("tenant_slug") != tenant_slug:
        return None
    td_id = payload.get("td_id")
    if not td_id:
        return None
    device_uuid_hash = hash_device_uuid(device_uuid)
    now = _utcnow_naive()
    return db.query(TrustedDevice).filter(
        TrustedDevice.id == td_id,
        TrustedDevice.user_id == user_id,
        TrustedDevice.device_uuid == device_uuid_hash,
        TrustedDevice.is_active == True,
        TrustedDevice.expires_at > now,
    ).first()


def _save_trusted_device(
    request: Request,
    db: Session,
    user_id: int,
    device_uuid: str,
    device_label: str,
    ip: str,
    tenant_slug: str,
    response: Response,
) -> None:
    device_uuid_hash = hash_device_uuid(device_uuid)
    now = _utcnow_naive()
    td = db.query(TrustedDevice).filter(
        TrustedDevice.user_id == user_id,
        TrustedDevice.device_uuid == device_uuid_hash,
    ).first()
    if td:
        td.last_used_at = now
        td.expires_at = now + timedelta(days=TRUSTED_DEVICE_EXPIRE_DAYS)
        td.is_active = True
    else:
        td = TrustedDevice(
            user_id=user_id,
            device_uuid=device_uuid_hash,
            device_label=device_label,
            ip_address=ip,
            expires_at=now + timedelta(days=TRUSTED_DEVICE_EXPIRE_DAYS),
            is_active=True,
        )
        db.add(td)
    db.commit()
    db.refresh(td)
    td_token = create_trusted_device_token(td.id, user_id, tenant_slug)
    response.set_cookie(
        key=f"{TRUSTED_DEVICE_COOKIE_PREFIX}{tenant_slug}",
        value=td_token,
        max_age=TRUSTED_DEVICE_EXPIRE_DAYS * 86400,
        **_trusted_device_cookie_kwargs(request),
    )

def _absolute_asset_url(request: Optional[Request], path: Optional[str]) -> Optional[str]:
    if not path:
        return None

    clean = str(path).strip()
    if not clean:
        return None

    if clean.startswith("http://") or clean.startswith("https://"):
        return clean

    configured_base = str(getattr(settings, "FRONTEND_BASE_URL", "") or "").strip().rstrip("/")
    if configured_base:
        if clean.startswith("/"):
            return f"{configured_base}{clean}"
        return f"{configured_base}/{clean}"

    if not request:
        return clean

    base_url = str(request.base_url).rstrip("/")
    if clean.startswith("/"):
        return f"{base_url}{clean}"

    return f"{base_url}/{clean}"


def _get_company_logo_from_settings(db: Session) -> Optional[str]:
    """
    Reads company logo path from tenant settings.
    Checks tenant_settings (primary store, key='theme_logo') first,
    then falls back to legacy settings table (key='company_logo').
    """
    try:
        inspector = inspect(db.get_bind())
        table_names = set(inspector.get_table_names())

        # Primary store: tenant_settings table, key = 'theme_logo'
        if "tenant_settings" in table_names:
            row = db.execute(
                text("""
                    SELECT `value`
                    FROM `tenant_settings`
                    WHERE `key` IN ('theme_logo', 'company_logo')
                      AND `value` IS NOT NULL AND `value` != ''
                    ORDER BY FIELD(`key`, 'theme_logo', 'company_logo')
                    LIMIT 1
                """)
            ).fetchone()
            if row:
                return str(row[0] or "").strip() or None

        # Fallback: legacy settings table, key = 'company_logo'
        if "settings" in table_names:
            row = db.execute(
                text("""
                    SELECT `value`
                    FROM `settings`
                    WHERE `key` IN ('theme_logo', 'company_logo')
                      AND `value` IS NOT NULL AND `value` != ''
                    ORDER BY FIELD(`key`, 'theme_logo', 'company_logo')
                    LIMIT 1
                """)
            ).fetchone()
            if row:
                return str(row[0] or "").strip() or None

        return None

    except Exception as exc:
        logger.warning("Company logo fetch skipped: %s", exc)
        return None


def _finalize_login_success(
    *,
    db: Session,
    master_db: Session,
    tenant_slug: str,
    tenant: Tenant,
    user: User,
    remember_me: bool,
    ip: str,
    device_label: str,
    fcm_token: Optional[str] = None,
    request: Optional[Request] = None,
) -> LoginResponse:
    expiry_minutes = get_login_expiry_minutes(master_db, tenant_slug, remember_me)
    session_expires_delta = timedelta(minutes=expiry_minutes)
    access_expires_delta = timedelta(minutes=get_access_token_expiry_minutes(expiry_minutes))
    should_send_device_alert = _should_send_new_device_login_alert(db, tenant, user, device_label)
    session_jti = secrets.token_hex(16)
    browser_name, os_name = _split_device_label(device_label)
    logged_in_at = _istnow_naive()

    reset_attempts(tenant_slug, user.username)
    permissions = get_role_permissions_from_db(db, user.role)
    access_token = create_access_token(
        user.id,
        tenant_id=tenant.id,
        expires_delta=access_expires_delta,
        session_jti=session_jti,
    )
    refresh_token = create_refresh_token(
        user.id,
        tenant_id=tenant.id,
        expires_delta=session_expires_delta,
        session_jti=session_jti,
    )

    db.add(UserSession(
        user_id=user.id,
        refresh_token_hash=hash_token(refresh_token),
        session_jti=session_jti,
        device=device_label,
        browser=browser_name,
        os=os_name,
        ip_address=ip,
        login_time=logged_in_at,
        last_active=logged_in_at,
        is_active=True,
    ))
    db.add(LoginAttempt(user_id=user.id, username=user.username, ip_address=ip, success=True, user_agent=device_label, created_at=logged_in_at))
    user.last_login = logged_in_at
    # Login is a successful authentication event, so persist it in the tenant's
    # Audit Logs table alongside logout events.  This must happen before the
    # commit below; the audit row and session creation then remain atomic.
    log_audit_db(
        db,
        user.id,
        "auth",
        "login",
        user.id,
        ip,
        description="User signed in",
        new_data={
            "device": device_label,
            "remember_me": remember_me,
            "session_expires_in_minutes": expiry_minutes,
        },
    )
    db.commit()

    normalized_fcm_token = (fcm_token or "").strip()
    if normalized_fcm_token:
        try:
            register_push_token(
                db,
                user_id=user.id,
                token=normalized_fcm_token,
                platform="mobile",
                device_name=device_label,
            )
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.warning("FCM token save skipped for user_id=%s: %s", user.id, exc)

    if should_send_device_alert:
        _send_new_device_login_alert(tenant, user, device_label, ip)

    log_auth_event(
        "LOGIN_SUCCESS",
        user.username,
        ip,
        True,
        f"remember_me={remember_me} expiry_minutes={expiry_minutes}",
    )
    log_audit(None, user.id, "auth", "login", ip)
    company_logo = _get_company_logo_from_settings(db)
    return LoginResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        user_id=user.id,
        username=user.username,
        full_name=user.full_name,
        role=user.role,
        permissions=permissions,
        company_logo=company_logo,
company_logo_url=company_logo,        **build_session_policy_payload(tenant, remember_me=remember_me),
    )


# --- Routes -------------------------------------------------------------------

@router.get("/mobile/org-info", response_model=MobileOrgInfoResponse)
def mobile_org_info(
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
):
    """
    Auto-fetch organization info for the mobile app.
    The org is resolved from the request subdomain — no extra parameter needed.
    """
    tenant_slug = _resolve_tenant_slug(request)
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found.")
    logo_path = _get_company_logo_from_settings(db)
    return MobileOrgInfoResponse(
        org_name=tenant.name or tenant_slug,
        slug=tenant_slug,
        subdomain=tenant.subdomain or tenant_slug,
        org_logo_url=_absolute_asset_url(request, logo_path),
    )


@router.get("/captcha-status/{username}", response_model=CaptchaStatusResponse)
def captcha_status(
    username: str,
    request: Request,
    master_db: Session = Depends(get_master_db_dep),
):
    tenant_slug = _resolve_tenant_slug(request)
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
    global_maintenance = master_db.query(PlatformSetting).filter(PlatformSetting.key == "global_maintenance_mode").first()
    if global_maintenance and global_maintenance.value_bool:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="This application is currently under maintenance.")
    captcha_mode = _normalize_captcha_mode(getattr(tenant, "captcha_mode", CAPTCHA_MODE_AFTER_FAILED))
    return CaptchaStatusResponse(
        requires_captcha  = _login_requires_captcha(tenant_slug, username, captcha_mode),
        is_locked         = is_locked_out(tenant_slug, username),
        remaining_seconds = get_remaining_lockout(tenant_slug, username),
        attempts          = get_attempt_count(tenant_slug, username),
    )


def _enforce_platform_block(request: Request, user, tenant=None, master_db: Optional[Session] = None) -> None:
    """Platform Trust & Safety blocklist: a terminated user, a blocked email domain or a blocked device can't sign in,
    even if the account is re-activated inside the tenant. A blocklist that can't be read doesn't stop sign-in
    (terminated users are also deactivated in the tenant database)."""
    from app.database import MasterSessionLocal
    from app.services.platform_trust_safety import blocked_sign_in
    own = None
    kind = None
    try:
        if master_db is None:
            own = master_db = MasterSessionLocal()
        if tenant is None:
            tenant = master_db.query(Tenant).filter(Tenant.slug == getattr(request.state, "tenant_slug", None)).first()
        if tenant is not None:
            kind = blocked_sign_in(master_db, tenant.id, getattr(user, "id", None), getattr(user, "email", None), request.headers.get("X-Device-UUID"))
    except Exception:
        logger.exception("Platform access blocklist check failed")
    finally:
        if own is not None:
            own.close()
    if kind:
        log_auth_event("LOGIN_BLOCKED_PLATFORM", getattr(user, "username", ""), get_request_ip(request), False, f"platform block: {kind}")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This account has been disabled. Contact your administrator.")


def _enforce_mobile_policy(request: Request, user, tenant=None, master_db: Optional[Session] = None, is_mobile: bool = True) -> None:
    """Platform Mobile app control, for mobile sign-ins only: tenant mobile access, role access, blocked users and – when the
    app sends X-App-Platform / X-App-Version / X-OS-Version – minimum and blocked versions. Defaults allow everything."""
    if not is_mobile:
        return
    from app.database import MasterSessionLocal
    from app.services import platform_mobile
    own = None
    reason = None
    try:
        if master_db is None:
            own = master_db = MasterSessionLocal()
        if tenant is None:
            tenant = master_db.query(Tenant).filter(Tenant.slug == getattr(request.state, "tenant_slug", None)).first()
        if tenant is not None:
            reason = platform_mobile.mobile_block_reason(master_db, tenant, user, request.headers.get("X-App-Platform"),
                                                         request.headers.get("X-App-Version"), request.headers.get("X-OS-Version"))
    except Exception:
        logger.exception("Mobile policy check failed")
    finally:
        if own is not None:
            own.close()
    if reason:
        log_auth_event("LOGIN_BLOCKED_MOBILE", getattr(user, "username", ""), get_request_ip(request), False, reason[1])
        raise HTTPException(status_code=reason[0], detail=reason[1])


def _is_mobile_client(request: Request) -> bool:
    return (request.headers.get("user-agent") or "").startswith("Dart/")


@router.post("/login", response_model=LoginResponse)
def login(
    data:      LoginRequest,
    request:   Request,
    db:        Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
):
    tenant_slug = _resolve_tenant_slug(request)
    request.state.tenant_slug = tenant_slug
    is_mobile = (data.login_from or "web").strip().lower() == "mobile"
    logger.info(f"LOGIN | tenant={tenant_slug} user={data.username} from={data.login_from or 'web'}")
    ip = get_request_ip(request)
    ua = request.headers.get("user-agent", "")
    device_label = _normalize_login_device_label(ua)
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
    global_maintenance = master_db.query(PlatformSetting).filter(PlatformSetting.key == "global_maintenance_mode").first()
    if global_maintenance and global_maintenance.value_bool:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="This application is currently under maintenance.")
    captcha_mode = _normalize_captcha_mode(getattr(tenant, "captcha_mode", CAPTCHA_MODE_AFTER_FAILED))

    if is_locked_out(tenant_slug, data.username):
        remaining = get_remaining_lockout(tenant_slug, data.username)
        log_auth_event("LOGIN_BLOCKED", data.username, ip, False, f"locked, {remaining}s remaining")
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail=f"Account temporarily locked. Try again in {remaining} seconds.")

    # Captcha is a web-only check — mobile apps handle their own verification flow
    if not is_mobile and _login_requires_captcha(tenant_slug, data.username, captcha_mode) and not data.captcha_token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="CAPTCHA required. Please complete verification.")

    user = db.query(User).filter(User.username == data.username, User.is_active == True).first()

    if not user or not verify_password(data.password, user.hashed_password):
        record = record_failed_attempt(tenant_slug, data.username, captcha_mode)
        db.add(LoginAttempt(username=data.username, ip_address=ip, success=False, user_agent=ua, created_at=_istnow_naive()))
        db.commit()
        log_auth_event("LOGIN_FAILED", data.username, ip, False, f"attempts={record['attempts']}")
        if is_locked_out(tenant_slug, data.username):
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                                detail="Too many failed attempts. Account locked.")
        attempts_left = max(0, 5 - record["attempts"])
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail=f"Invalid credentials. {attempts_left} attempt(s) remaining.")

    _enforce_platform_block(request, user, tenant, master_db)
    _enforce_mobile_policy(request, user, tenant, master_db, is_mobile or _is_mobile_client(request))
    password_change_requirement = evaluate_password_change_requirement(tenant, user)
    if password_change_requirement.must_change_password:
        should_send_device_alert = _should_send_new_device_login_alert(db, tenant, user, device_label)
        password_change_message = (
            PASSWORD_EXPIRED_MESSAGE
            if password_change_requirement.password_expired
            else "Please reset or change your password to continue."
        )
        reset_attempts(tenant_slug, data.username)
        db.add(LoginAttempt(user_id=user.id, username=user.username, ip_address=ip, success=True, user_agent=device_label, created_at=_istnow_naive()))
        db.commit()

        if should_send_device_alert:
            _send_new_device_login_alert(tenant, user, device_label, ip)

        log_auth_event(
            "LOGIN_PASSWORD_CHANGE_REQUIRED",
            data.username,
            ip,
            True,
            f"tenant={tenant_slug} password_expired={password_change_requirement.password_expired}",
        )
        log_audit(
            tenant.id,
            user.id,
            "auth",
            "password_change_required",
            ip,
            f"tenant={tenant_slug} password_expired={password_change_requirement.password_expired}",
        )
        company_logo = _get_company_logo_from_settings(db)

        return LoginResponse(
            user_id=user.id,
            username=user.username,
            full_name=user.full_name,
            role=user.role,
            permissions=get_role_permissions_from_db(db, user.role),
            password_expired=password_change_requirement.password_expired,
            must_change_password=True,
            password_reset_token=password_change_requirement.reset_token,
            message=password_change_message,
            company_logo=company_logo,
    company_logo_url=company_logo,        )

    # Mobile logins skip OTP / trusted-device checks entirely —
    # only username + password (+ first-time reset) applies.
    
    if is_mobile:
        return _finalize_login_success(
            db=db,
            master_db=master_db,
            tenant_slug=tenant_slug,
            tenant=tenant,
            user=user,
            remember_me=data.remember_me,
            ip=ip,
            device_label=device_label,
            fcm_token=data.fcm_token,
            request=request,
        )

    otp_mode = str(getattr(tenant, 'otp_mode', 'always') or 'always').strip()
    if otp_mode == 'never':
        return _finalize_login_success(
            db=db,
            master_db=master_db,
            tenant_slug=tenant_slug,
            tenant=tenant,
            user=user,
            remember_me=data.remember_me,
            ip=ip,
            device_label=device_label,
            fcm_token=data.fcm_token,
            request=request,
        )

    trusted_device = _check_trusted_device(request, db, user.id, tenant_slug)
    if trusted_device:
        trusted_device.last_used_at = _utcnow_naive()
        db.commit()
        return _finalize_login_success(
            db=db,
            master_db=master_db,
            tenant_slug=tenant_slug,
            tenant=tenant,
            user=user,
            remember_me=data.remember_me,
            ip=ip,
            device_label=device_label,
            fcm_token=data.fcm_token,
            request=request,
        )

    if not (getattr(user, "email", None) or "").strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Your account does not have an email address for login verification. Please contact your administrator.",
        )

    _ensure_login_otp_schema(db)
    _cleanup_stale_login_otp_challenges(db)
    reset_attempts(tenant_slug, data.username)
    permissions = get_role_permissions_from_db(db, user.role)
    db.query(LoginOTPChallenge).filter(
        LoginOTPChallenge.user_id == user.id,
        LoginOTPChallenge.consumed_at.is_(None),
    ).delete(synchronize_session=False)

    challenge_id = secrets.token_urlsafe(24)
    otp_code = _generate_login_otp_code()
    challenge = LoginOTPChallenge(
        challenge_id=challenge_id,
        user_id=user.id,
        username=user.username,
        otp_hash=_hash_login_otp(challenge_id, otp_code),
        remember_me=bool(data.remember_me),
        ip_address=ip,
        user_agent=device_label,
        fcm_token=(data.fcm_token or "").strip() or None,
        failed_attempts=0,
        resend_count=0,
        expires_at=_utcnow_naive() + timedelta(minutes=LOGIN_OTP_EXPIRY_MINUTES),
        sent_at=_utcnow_naive(),
    )
    db.add(challenge)

    try:
        _send_login_otp_email(
            tenant=tenant,
            user=user,
            otp_code=otp_code,
            expiry_minutes=LOGIN_OTP_EXPIRY_MINUTES,
            device_label=device_label,
            ip_address=ip,
        )
    except TenantEmailConfigurationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Login verification email is not configured for this company. Please contact your administrator.",
        ) from exc
    except TenantEmailDeliveryError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to send the login verification code right now. Please try again.",
        ) from exc

    db.commit()
    log_auth_event(
        "LOGIN_OTP_SENT",
        data.username,
        ip,
        True,
        f"remember_me={data.remember_me} expires_in={LOGIN_OTP_EXPIRY_MINUTES}m",
    )
    return _build_login_otp_response(
        db=db,
        request=request,
        user=user,
        permissions=permissions,
        challenge_id=challenge_id,
        email=user.email,
        message="A verification code has been sent to your email address.",
    )


@router.post("/quick-pin/verify-account", response_model=QuickPinVerifyAccountResponse)
def verify_quick_pin_account(
    data: QuickPinVerifyAccountRequest,
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
):
    """
    Step 1 — Identify employee by username + optional employee_code / emp_id.
    Sends a 6-digit OTP to their registered email.
    Returns challenge_id; proceed to /quick-pin/verify-otp.
    """
    tenant_slug = _resolve_tenant_slug(request)
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found.")

    username = (data.username or "").strip()
    if not username:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username is required.")

    user = db.query(User).filter(User.username == username, User.is_active == True).first()
    # Validate optional identity fields — generic error to avoid user enumeration
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found. Please check your details.")

    if data.email is not None:
        provided_email = str(data.email).strip().lower()
        if provided_email and (user.email or "").strip().lower() != provided_email:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found. Please check your details.")

    if data.employee_code is not None:
        emp_code = str(data.employee_code).strip()
        if emp_code and (user.employee_code or "").strip() != emp_code:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found. Please check your details.")

    if data.emp_id is not None:
        if user.id != int(data.emp_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found. Please check your details.")

    if not (user.email or "").strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Your account does not have an email address. Please contact your administrator.",
        )

    _ensure_login_otp_schema(db)
    _cleanup_stale_login_otp_challenges(db)

    # Cancel any previous pin-setup challenges for this user
    db.query(LoginOTPChallenge).filter(
        LoginOTPChallenge.user_id == user.id,
        LoginOTPChallenge.consumed_at.is_(None),
        LoginOTPChallenge.user_agent == "QUICKPIN_SETUP",
    ).delete(synchronize_session=False)

    challenge_id = "qps_" + secrets.token_urlsafe(22)
    otp_code = _generate_login_otp_code()
    challenge = LoginOTPChallenge(
        challenge_id=challenge_id,
        user_id=user.id,
        username=user.username,
        otp_hash=_hash_login_otp(challenge_id, otp_code),
        remember_me=False,
        ip_address=get_request_ip(request),
        user_agent="QUICKPIN_SETUP",
        fcm_token=None,
        failed_attempts=0,
        resend_count=0,
        expires_at=_utcnow_naive() + timedelta(minutes=LOGIN_OTP_EXPIRY_MINUTES),
        sent_at=_utcnow_naive(),
    )
    db.add(challenge)

    try:
        _send_quick_pin_setup_otp_email(
            tenant=tenant,
            user=user,
            otp_code=otp_code,
            expiry_minutes=LOGIN_OTP_EXPIRY_MINUTES,
        )
    except TenantEmailConfigurationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email is not configured for this organisation. Please contact your administrator.",
        ) from exc
    except TenantEmailDeliveryError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to send the verification code right now. Please try again.",
        ) from exc

    db.commit()
    log_auth_event("QUICKPIN_OTP_SENT", user.username, get_request_ip(request), True, f"tenant={tenant_slug}")
    return QuickPinVerifyAccountResponse(
        challenge_id=challenge_id,
        user_id=user.id,
        username=user.username,
        full_name=user.full_name,
        company_code=tenant_slug,
        otp_expires_in_seconds=LOGIN_OTP_EXPIRY_MINUTES * 60,
        otp_delivery_target=_mask_email_address(user.email),
    )


@router.post("/quick-pin/verify-otp", response_model=QuickPinSetupTokenResponse)
def verify_quick_pin_otp(
    data: QuickPinVerifyOtpRequest,
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
):
    """
    Step 2 — Verify the OTP sent to email.
    Returns a short-lived setup_token; use it with /quick-pin/set to save the PIN.
    """
    tenant_slug = _resolve_tenant_slug(request)
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found.")

    challenge_id = (data.challenge_id or "").strip()
    if not challenge_id.startswith("qps_"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Verification session not found.")

    _ensure_login_otp_schema(db)
    _cleanup_stale_login_otp_challenges(db)

    challenge = db.query(LoginOTPChallenge).filter(
        LoginOTPChallenge.challenge_id == challenge_id,
        LoginOTPChallenge.user_agent == "QUICKPIN_SETUP",
    ).first()
    if not challenge or challenge.consumed_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Verification session not found or already used.")

    now = _utcnow_naive()
    if challenge.expires_at <= now:
        db.delete(challenge)
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Verification code has expired. Please start again.")

    if challenge.failed_attempts >= LOGIN_OTP_MAX_ATTEMPTS:
        db.delete(challenge)
        db.commit()
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many incorrect attempts. Please start again.")

    normalized_otp = _normalize_otp_code(data.otp)
    if len(normalized_otp) != LOGIN_OTP_LENGTH:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Enter the 6-digit verification code.")

    if not _login_otp_matches(challenge, normalized_otp):
        challenge.failed_attempts += 1
        remaining = max(0, LOGIN_OTP_MAX_ATTEMPTS - challenge.failed_attempts)
        if challenge.failed_attempts >= LOGIN_OTP_MAX_ATTEMPTS:
            db.delete(challenge)
            db.commit()
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many incorrect attempts. Please start again.")
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid verification code. {remaining} attempt(s) remaining.",
        )

    user = db.query(User).filter(User.id == challenge.user_id, User.is_active == True).first()
    if not user:
        db.delete(challenge)
        db.commit()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")

    challenge.consumed_at = now
    _ensure_quick_pin_schema(db)
    setup_token = create_quick_pin_setup_token(
        user.id,
        tenant_id=tenant.id,
        tenant_slug=tenant_slug,
    )
    db.commit()
    log_auth_event("QUICKPIN_OTP_VERIFIED", user.username, get_request_ip(request), True, f"tenant={tenant_slug}")
    return QuickPinSetupTokenResponse(
        setup_token=setup_token,
        user_id=user.id,
        username=user.username,
        full_name=user.full_name,
        company_code=tenant_slug,
    )


@router.post("/quick-pin/set")
def set_quick_pin(
    data: QuickPinSetRequest,
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
):
    tenant_slug = _resolve_tenant_slug(request)
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")

    token_payload = verify_quick_pin_setup_token(data.setup_token.strip())
    if (
        not token_payload
        or int(token_payload.get("tenant_id") or 0) != int(tenant.id)
        or str(token_payload.get("tenant_slug") or "") != tenant_slug
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Quick PIN setup session expired. Verify your account again.")

    pin = _require_quick_pin(data.pin)
    confirm_pin = _require_quick_pin(data.confirm_pin)
    if pin != confirm_pin:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="PIN and confirm PIN do not match.")

    user_id = int(token_payload.get("user_id") or 0)
    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    _ensure_quick_pin_schema(db)
    credential = db.query(QuickPinCredential).filter(
        QuickPinCredential.user_id == user.id,
    ).first()
    if not credential:
        credential = QuickPinCredential(
            user_id=user.id,
            device_uuid_hash="",
        )
        db.add(credential)

    credential.pin_hash = hash_password(pin)
    credential.failed_attempts = 0
    credential.locked_until = None
    credential.is_active = True
    credential.updated_at = _utcnow_naive()
    db.commit()
    return {"ok": True, "message": "Quick PIN saved successfully."}


@router.post("/quick-pin/login", response_model=LoginResponse)
def quick_pin_login(
    data: QuickPinLoginRequest,
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
):
    """
    Step 4 — Daily mobile login using employee_code + PIN.
    Requires X-Device-UUID header. Returns access + refresh tokens with company logo.
    """
    tenant_slug = _resolve_tenant_slug(request)
    request.state.tenant_slug = tenant_slug
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found.")

    employee_code = (data.employee_code or "").strip()
    if not employee_code:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Employee code is required.")

    pin = _require_quick_pin(data.pin)
    ip = get_request_ip(request)
    device_label = _normalize_login_device_label(request.headers.get("user-agent", ""))

    # Find user by employee_code
    user = db.query(User).filter(
    or_(
        User.employee_code == employee_code,
        User.username == employee_code,
    ),
    User.is_active == True,
    ).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found.")
    _enforce_platform_block(request, user, tenant, master_db)
    _enforce_mobile_policy(request, user, tenant, master_db)

    _ensure_quick_pin_schema(db)
    credential = db.query(QuickPinCredential).filter(
        QuickPinCredential.user_id == user.id,
        QuickPinCredential.is_active == True,
    ).first()
    if not credential:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Quick PIN is not set up for this employee. Please set up your PIN first.",
        )

    now = _utcnow_naive()
    if credential.locked_until and credential.locked_until > now:
        remaining = max(1, int((credential.locked_until - now).total_seconds()))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Quick PIN locked. Try again in {remaining} seconds.",
        )

    if not verify_password(pin, credential.pin_hash):
        credential.failed_attempts = int(credential.failed_attempts or 0) + 1
        if credential.failed_attempts >= QUICK_PIN_MAX_ATTEMPTS:
            credential.locked_until = now + timedelta(minutes=QUICK_PIN_LOCK_MINUTES)
            credential.failed_attempts = QUICK_PIN_MAX_ATTEMPTS
        db.add(LoginAttempt(username=user.username, ip_address=ip, success=False, user_agent=device_label, created_at=_istnow_naive()))
        db.commit()
        if credential.locked_until and credential.locked_until > now:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Too many invalid PIN attempts. Try again in {QUICK_PIN_LOCK_MINUTES} minutes.",
            )
        attempts_left = max(0, QUICK_PIN_MAX_ATTEMPTS - int(credential.failed_attempts or 0))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid PIN. {attempts_left} attempt(s) remaining.",
        )

    password_change_requirement = evaluate_password_change_requirement(tenant, user)
    if password_change_requirement.must_change_password:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Please sign in with your password and change it before using Quick PIN.",
        )

    credential.failed_attempts = 0
    credential.locked_until = None
    credential.last_used_at = now
    credential.updated_at = now
    db.commit()

    return _finalize_login_success(
        db=db,
        master_db=master_db,
        tenant_slug=tenant_slug,
        tenant=tenant,
        user=user,
        remember_me=bool(data.remember_me),
        ip=ip,
        device_label=device_label,
        fcm_token=data.fcm_token,
        request=request,
    )


@router.get("/quick-pin/status")
def quick_pin_status(
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """
    Returns whether a Quick PIN is configured for this user and whether it is locked.
    Requires a valid JWT (Authorization: Bearer ...).
    """
    _ensure_quick_pin_schema(db)
    credential = db.query(QuickPinCredential).filter(
        QuickPinCredential.user_id == current_user.id,
        QuickPinCredential.is_active == True,
    ).first()

    if not credential:
        return {"is_set": False, "is_locked": False, "locked_until": None, "failed_attempts": 0}

    now = _utcnow_naive()
    is_locked = bool(credential.locked_until and credential.locked_until > now)
    locked_until_iso = credential.locked_until.isoformat() + "Z" if is_locked else None
    remaining_seconds = max(0, int((credential.locked_until - now).total_seconds())) if is_locked else 0

    return {
        "is_set": True,
        "is_locked": is_locked,
        "locked_until": locked_until_iso,
        "locked_until_seconds": remaining_seconds,
        "failed_attempts": int(credential.failed_attempts or 0),
        "last_used_at": credential.last_used_at.isoformat() + "Z" if credential.last_used_at else None,
    }


@router.delete("/quick-pin")
def clear_quick_pin(
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """
    Removes the Quick PIN for this employee.
    After this, the employee must go through verify-account → verify-otp → set again.
    Requires a valid JWT (Authorization: Bearer ...).
    """
    _ensure_quick_pin_schema(db)
    credential = db.query(QuickPinCredential).filter(
        QuickPinCredential.user_id == current_user.id,
    ).first()

    if not credential:
        return {"ok": True, "message": "No Quick PIN was set."}

    db.delete(credential)
    db.commit()
    log_auth_event("QUICKPIN_CLEARED", current_user.username, get_request_ip(request), True)
    return {"ok": True, "message": "Quick PIN removed. Set up a new PIN anytime from the app."}


@router.post("/login/verify-otp", response_model=LoginResponse)
def verify_login_otp(
    data: VerifyLoginOtpRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
):
    tenant_slug = _resolve_tenant_slug(request)
    request.state.tenant_slug = tenant_slug
    ip = get_request_ip(request)

    _ensure_login_otp_schema(db)
    _cleanup_stale_login_otp_challenges(db)

    cid = (data.challenge_id or "").strip()
    # Reject quick-pin-setup challenges from the login verify path
    if cid.startswith("qps_"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Login verification challenge not found.")

    challenge = db.query(LoginOTPChallenge).filter(
        LoginOTPChallenge.challenge_id == cid,
    ).first()
    if not challenge or challenge.consumed_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Login verification challenge not found.")

    now = _utcnow_naive()
    if challenge.expires_at <= now:
        db.delete(challenge)
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The verification code has expired. Please sign in again.")

    if challenge.failed_attempts >= LOGIN_OTP_MAX_ATTEMPTS:
        db.delete(challenge)
        db.commit()
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many invalid verification attempts. Please sign in again.")

    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")

    user = db.query(User).filter(User.id == challenge.user_id, User.is_active == True).first()
    if not user:
        db.delete(challenge)
        db.commit()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    _enforce_platform_block(request, user, tenant, master_db)

    normalized_otp = _normalize_otp_code(data.otp)
    if len(normalized_otp) != LOGIN_OTP_LENGTH:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Enter the 6-digit verification code.")

    if not _login_otp_matches(challenge, normalized_otp):
        challenge.failed_attempts += 1
        remaining_attempts = max(0, LOGIN_OTP_MAX_ATTEMPTS - challenge.failed_attempts)
        if challenge.failed_attempts >= LOGIN_OTP_MAX_ATTEMPTS:
            db.delete(challenge)
            db.commit()
            log_auth_event("LOGIN_OTP_FAILED", user.username, ip, False, "max attempts reached")
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many invalid verification attempts. Please sign in again.")

        challenge_id_prefix = str(challenge.challenge_id or "")[:8]
        stored_hash_len = len(str(challenge.otp_hash or ""))
        failed_attempts = challenge.failed_attempts
        db.commit()
        logger.warning(
            "LOGIN_OTP_VERIFY_MISMATCH | tenant=%s user=%s challenge_id_prefix=%s hash_len=%s failed_attempts=%s",
            tenant_slug,
            user.username,
            challenge_id_prefix,
            stored_hash_len,
            failed_attempts,
        )
        log_auth_event("LOGIN_OTP_FAILED", user.username, ip, False, f"remaining_attempts={remaining_attempts}")
        hint = " If you signed in more than once, use the code from your most recent email." if challenge.resend_count == 0 and challenge.failed_attempts == 1 else ""
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid verification code. {remaining_attempts} attempt(s) remaining.{hint}",
        )

    challenge.otp_hash = _hash_login_otp(challenge.challenge_id, normalized_otp)
    challenge.consumed_at = now
    db.query(LoginOTPChallenge).filter(
        LoginOTPChallenge.user_id == user.id,
        LoginOTPChallenge.challenge_id != challenge.challenge_id,
        LoginOTPChallenge.consumed_at.is_(None),
    ).delete(synchronize_session=False)

    device_label_used = challenge.user_agent or request.headers.get("user-agent", "")
    ip_used = challenge.ip_address or ip
    login_result = _finalize_login_success(
        db=db,
        master_db=master_db,
        tenant_slug=tenant_slug,
        tenant=tenant,
        user=user,
        remember_me=bool(challenge.remember_me),
        ip=ip_used,
        device_label=device_label_used,
        fcm_token=getattr(challenge, "fcm_token", None),
        request=request,
    )
    device_uuid = (request.headers.get("X-Device-UUID") or "").strip()
    if device_uuid:
        _save_trusted_device(
            request=request,
            db=db,
            user_id=user.id,
            device_uuid=device_uuid,
            device_label=device_label_used,
            ip=ip_used,
            tenant_slug=tenant_slug,
            response=response,
        )
    return login_result


@router.post("/login/resend-otp", response_model=LoginResponse)
def resend_login_otp(
    data: ResendLoginOtpRequest,
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
):
    tenant_slug = _resolve_tenant_slug(request)
    request.state.tenant_slug = tenant_slug
    ip = get_request_ip(request)

    _ensure_login_otp_schema(db)
    _cleanup_stale_login_otp_challenges(db)

    cid = (data.challenge_id or "").strip()
    if cid.startswith("qps_"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Login verification challenge not found.")

    challenge = db.query(LoginOTPChallenge).filter(
        LoginOTPChallenge.challenge_id == cid,
    ).first()
    if not challenge or challenge.consumed_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Login verification challenge not found.")

    now = _utcnow_naive()
    if challenge.expires_at <= now:
        db.delete(challenge)
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The verification code has expired. Please sign in again.")

    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")

    user = db.query(User).filter(User.id == challenge.user_id, User.is_active == True).first()
    if not user:
        db.delete(challenge)
        db.commit()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    _enforce_platform_block(request, user, tenant, master_db)

    otp_code = _generate_login_otp_code()
    challenge.otp_hash = _hash_login_otp(challenge.challenge_id, otp_code)
    challenge.failed_attempts = 0
    challenge.resend_count = int(challenge.resend_count or 0) + 1
    challenge.sent_at = now
    challenge.expires_at = now + timedelta(minutes=LOGIN_OTP_EXPIRY_MINUTES)

    try:
        _send_login_otp_email(
            tenant=tenant,
            user=user,
            otp_code=otp_code,
            expiry_minutes=LOGIN_OTP_EXPIRY_MINUTES,
            device_label=challenge.user_agent or request.headers.get("user-agent", ""),
            ip_address=challenge.ip_address or ip,
        )
    except TenantEmailConfigurationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Login verification email is not configured for this company. Please contact your administrator.",
        ) from exc
    except TenantEmailDeliveryError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to resend the verification code right now. Please try again.",
        ) from exc

    db.commit()
    log_auth_event("LOGIN_OTP_RESENT", user.username, ip, True, f"resend_count={challenge.resend_count}")
    return _build_login_otp_response(
        db=db,
        request=request,
        user=user,
        permissions=get_role_permissions_from_db(db, user.role),
        challenge_id=challenge.challenge_id,
        email=user.email,
        message="A new verification code has been sent to your email address.",
    )


@router.post("/refresh", response_model=LoginResponse)
def refresh_token(
    data: RefreshRequest,
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
):
    payload = verify_token(data.refresh_token, "refresh")
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    tenant_slug = _resolve_tenant_slug(request)
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    try:
        token_tenant_id = int(payload["tenant_id"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        ) from exc

    if not tenant or token_tenant_id != tenant.id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    user_id = int(payload["sub"])
    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    _enforce_platform_block(request, user, tenant, master_db)
    _enforce_mobile_policy(request, user, tenant, master_db, _is_mobile_client(request))
    session_row = ensure_token_session_is_active(payload, tenant, user, db)
    if session_row is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    expected_refresh_hash = hash_token(data.refresh_token)
    if session_row.refresh_token_hash != expected_refresh_hash:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    exp_ts = int(payload.get("exp", 0))
    now_ts = int(aware_now_ist().timestamp())
    remaining_seconds = exp_ts - now_ts
    if remaining_seconds <= 0:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token expired")

    touch_user_session_activity(db, session_row)
    access_token_seconds = min(remaining_seconds, get_access_token_expiry_minutes(remaining_seconds // 60 or 1) * 60)
    db.commit()
    company_logo = _get_company_logo_from_settings(db)

    return LoginResponse(
        access_token=create_access_token(
            user.id,
            tenant_id=tenant.id,
            expires_delta=timedelta(seconds=access_token_seconds),
            session_jti=(payload.get("session_jti") or None),
        ),
        token_type="bearer",
        company_logo=company_logo,
company_logo_url=company_logo,        **build_session_policy_payload(tenant),
    )



@router.post("/session/activity")
def touch_session_activity(
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
    master_db: Session = Depends(get_master_db_dep),
):
    session_row = getattr(request.state, "current_session", None)
    if session_row is None:
        payload = _get_request_access_payload(request) or {}
        session_jti = str(payload.get("session_jti") or "").strip()
        if not session_jti:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session not found")
        session_row = db.query(UserSession).filter(
            UserSession.user_id == current_user.id,
            UserSession.session_jti == session_jti,
        ).first()
        if session_row is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session not found")

    touch_user_session_activity(db, session_row)
    db.commit()

    tenant_slug = getattr(request.state, "tenant_slug", None) or _resolve_tenant_slug(request)
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    return {
        "status": "ok",
        **build_session_policy_payload(tenant),
    }


@router.post("/logout")
def logout(request: Request, db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user)):
    payload = _get_request_access_payload(request) or {}
    revoked_sessions = _revoke_user_sessions(
        db,
        [current_user.id],
        revoked_by_user_id=current_user.id,
        revoke_reason="User signed out",
        revoke_scope="current_session",
        session_jti=(payload.get("session_jti") or None),
    )
    log_audit_db(
        db,
        current_user.id,
        "auth",
        "logout",
        current_user.id,
        get_request_ip(request),
        description="User signed out of the current session",
        new_data={
            "scope": "current_session",
            "revoked_session_count": revoked_sessions,
            "session_jti": payload.get("session_jti"),
        },
    )
    db.commit()
    log_auth_event("LOGOUT", current_user.username, get_request_ip(request), True)
    log_audit(None, current_user.id, "auth", "logout", get_request_ip(request))
    return {"message": "Logged out successfully"}


@router.post("/logout-all-devices")
def logout_all_devices(
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    current_session_jti = _get_request_session_jti(request)
    current_session_kept = bool(current_session_jti)
    revoked_sessions = _revoke_user_sessions(
        db,
        [current_user.id],
        revoked_by_user_id=current_user.id,
        revoke_reason="User logged out all other devices",
        revoke_scope="self",
        exclude_session_jti=current_session_jti,
    )
    log_audit_db(
        db,
        current_user.id,
        "auth",
        "logout_all_devices",
        current_user.id,
        get_request_ip(request),
        description="User logged out all other active devices",
        new_data={
            "scope": "self",
            "affected_user_ids": [current_user.id],
            "affected_user_count": 1,
            "revoked_session_count": revoked_sessions,
            "current_session_kept": current_session_kept,
            "preserved_session_jti": current_session_jti,
        },
    )
    db.commit()
    log_auth_event("LOGOUT_ALL_DEVICES", current_user.username, get_request_ip(request), True)
    log_audit(None, current_user.id, "auth", "logout_all_devices", get_request_ip(request))
    return {
        "message": (
            "Logged out from other active devices successfully"
            if current_session_kept
            else "Logged out from all active devices successfully"
        ),
        "affected_user_ids": [current_user.id],
        "affected_user_count": 1,
        "revoked_session_count": revoked_sessions,
        "current_session_kept": current_session_kept,
    }


@router.post("/forgot-password")
def forgot_password(
    data: ForgotPasswordRequest,
    request: Request,
    master_db: Session = Depends(get_master_db_dep),
):
    ip = get_request_ip(request)
    normalized_email = data.email.strip().lower()
    created_attempt = None

    try:
        created_attempt = protect_forgot_password_send_attempt(master_db, request, data.email)
    except PasswordResetError as exc:
        log_auth_event("FORGOT_PASSWORD_BLOCKED", normalized_email, ip, False, "rate limit exceeded")
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    employee_code = (data.employee_code or '').strip() or None
    try:
        target = request_password_reset(master_db, request, data.email, employee_code)
    except PasswordResetError as exc:
        if should_mask_forgot_password_error(exc):
            log_auth_event("FORGOT_PASSWORD_REQUEST", normalized_email, ip, True, "generic-response masked")
            return {"message": FORGOT_PASSWORD_GENERIC_SUCCESS_MESSAGE}
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    assign_forgot_password_attempt_tenant(master_db, created_attempt, target.tenant.id)
    log_auth_event("FORGOT_PASSWORD_REQUEST", target.email, ip, True, f"tenant={target.tenant.slug}")
    log_audit(
        target.tenant.id,
        target.user_id,
        "auth",
        "forgot_password_request",
        ip,
        f"tenant={target.tenant.slug}",
    )

    return {"message": FORGOT_PASSWORD_GENERIC_SUCCESS_MESSAGE}


@router.post("/reset-password")
def reset_password(
    data: ForgotPasswordResetPayload,
    request: Request,
    master_db: Session = Depends(get_master_db_dep),
):
    if not data.token or not data.token.strip():
        raise HTTPException(status_code=400, detail="Reset token is required")
    if not data.new_password:
        raise HTTPException(status_code=400, detail="New password is required")
    if not data.confirm_password:
        raise HTTPException(status_code=400, detail="Confirm password is required")
    if data.new_password != data.confirm_password:
        raise HTTPException(status_code=400, detail="New password and confirm password must match")

    try:
        result = reset_password_with_token(master_db, data.token.strip(), data.new_password)
    except PasswordResetError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    ip = get_request_ip(request)
    log_auth_event("PASSWORD_RESET_COMPLETED", result.email, ip, True, f"tenant={result.tenant.slug}")
    log_audit(result.tenant.id, result.user_id, "auth", "password_reset", ip, f"tenant={result.tenant.slug}")

    try:
        tenant_db = get_tenant_session_by_db_name(result.tenant.db_name, cache_key=result.tenant.slug)
        try:
            _revoke_user_sessions(
                tenant_db,
                [result.user_id],
                revoked_by_user_id=result.user_id,
                revoke_reason="Password reset — all sessions revoked",
                revoke_scope="password_reset",
            )
            tenant_db.commit()
        finally:
            tenant_db.close()
    except Exception:
        pass

    return {"message": "Password reset successfully. All active sessions have been logged out."}


@router.post("/contact-administrator")
def contact_administrator(
    data: ContactAdministratorRequest,
    request: Request,
    master_db: Session = Depends(get_master_db_dep),
):
    if not data.email and not (data.tenant_slug and data.username):
        raise HTTPException(
            status_code=400,
            detail="Email or organisation and username are required",
        )

    try:
        target = send_contact_administrator_request(
            master_db,
            request,
            email=data.email,
            tenant_slug=data.tenant_slug,
            username=data.username,
        )
    except PasswordResetError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    ip = get_request_ip(request)
    account_key = data.email or data.username or ""
    log_auth_event("CONTACT_ADMINISTRATOR", account_key, ip, True, f"tenant={target.tenant.slug}")
    log_audit(target.tenant.id, target.user_id, "auth", "contact_administrator", ip, f"tenant={target.tenant.slug}")
    return {"message": CONTACT_ADMIN_SUCCESS_MESSAGE}


@router.get("/me", response_model=UserResponse)
def get_me(
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    return _serialize_user_response(current_user, db, include_effective_groups=True)


class TrustedDeviceResponse(BaseModel):
    id: int
    device_label: Optional[str] = None
    ip_address: Optional[str] = None
    trusted_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    is_current: bool = False

    model_config = {"from_attributes": True}


@router.get("/me/trusted-devices", response_model=List[TrustedDeviceResponse])
def list_my_trusted_devices(
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    tenant_slug = getattr(request.state, "tenant_slug", None) or _resolve_tenant_slug(request)
    now = _utcnow_naive()
    devices = (
        db.query(TrustedDevice)
        .filter(
            TrustedDevice.user_id == current_user.id,
            TrustedDevice.is_active == True,
            TrustedDevice.expires_at > now,
        )
        # MariaDB has no NULLS LAST; sort NULLs last explicitly.
        .order_by(TrustedDevice.last_used_at.is_(None), TrustedDevice.last_used_at.desc(), TrustedDevice.trusted_at.desc())
        .all()
    )

    current_td_id: Optional[int] = None
    device_uuid = (request.headers.get("X-Device-UUID") or "").strip()
    cookie_token = request.cookies.get(f"{TRUSTED_DEVICE_COOKIE_PREFIX}{tenant_slug}", "")
    if device_uuid and cookie_token:
        payload = verify_trusted_device_token(cookie_token)
        if payload and payload.get("user_id") == current_user.id:
            current_td_id = payload.get("td_id")

    result = []
    for device in devices:
        result.append(TrustedDeviceResponse(
            id=device.id,
            device_label=device.device_label,
            ip_address=device.ip_address,
            trusted_at=device.trusted_at,
            last_used_at=device.last_used_at,
            expires_at=device.expires_at,
            is_current=(device.id == current_td_id),
        ))
    return result


@router.delete("/me/trusted-devices/{td_id}", status_code=200)
def revoke_trusted_device(
    td_id: int,
    request: Request,
    response: Response,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    tenant_slug = getattr(request.state, "tenant_slug", None) or _resolve_tenant_slug(request)
    device = db.query(TrustedDevice).filter(
        TrustedDevice.id == td_id,
        TrustedDevice.user_id == current_user.id,
    ).first()
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trusted device not found")
    device.is_active = False
    db.commit()

    cookie_token = request.cookies.get(f"{TRUSTED_DEVICE_COOKIE_PREFIX}{tenant_slug}", "")
    if cookie_token:
        payload = verify_trusted_device_token(cookie_token)
        if payload and payload.get("td_id") == td_id:
            response.delete_cookie(
                key=f"{TRUSTED_DEVICE_COOKIE_PREFIX}{tenant_slug}",
                **_trusted_device_cookie_kwargs(request),
            )

    log_auth_event("TRUSTED_DEVICE_REVOKED", current_user.username, get_request_ip(request), True, f"td_id={td_id}")
    return {"message": "Device trust revoked", "td_id": td_id}


@router.post("/me/request-reset")
def request_my_password_reset(
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
    master_db: Session = Depends(get_master_db_dep),
):
    if not (getattr(current_user, 'email', None) or '').strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Your account does not have an email address. Please contact your administrator.",
        )
    tenant_slug = _resolve_tenant_slug(request)
    ip = get_request_ip(request)
    try:
        send_admin_password_reset_link(
            master_db,
            request,
            tenant_slug=tenant_slug,
            user_id=current_user.id,
        )
    except PasswordResetError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    log_auth_event("SELF_PASSWORD_RESET_REQUESTED", current_user.username, ip, True, f"tenant={tenant_slug}")
    log_audit(None, current_user.id, "auth", "self_password_reset_requested", ip)
    return {"message": FORGOT_PASSWORD_GENERIC_SUCCESS_MESSAGE}


@router.get("/me/logout-history", response_model=List[LogoutHistoryEventResponse])
def get_my_logout_history(
    limit: int = 10,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    safe_limit = max(1, min(limit, 25))
    session_rows = (
        db.query(UserSession)
        .filter(
            UserSession.user_id == current_user.id,
            UserSession.revoked_at.isnot(None),
        )
        .order_by(UserSession.revoked_at.desc())
        .limit(safe_limit * 10)
        .all()
    )

    grouped_events: Dict[tuple, Dict[str, Any]] = {}
    actor_ids = {
        int(session_row.revoked_by_user_id)
        for session_row in session_rows
        if session_row.revoked_by_user_id
    }
    actor_rows = db.query(User).filter(User.id.in_(actor_ids)).all() if actor_ids else []
    actor_names = {
        actor.id: (actor.full_name or actor.username or f"User #{actor.id}")
        for actor in actor_rows
    }

    for session_row in session_rows:
        if session_row.revoke_scope == "current_session":
            continue

        revoked_at = session_row.revoked_at
        if revoked_at is None:
            continue

        actor_id = int(session_row.revoked_by_user_id) if session_row.revoked_by_user_id else None
        key = (
            revoked_at.isoformat(),
            actor_id,
            (session_row.revoke_scope or "").strip(),
            (session_row.revoke_reason or "").strip(),
        )

        if key not in grouped_events:
            actor_name = (
                "You" if actor_id == current_user.id
                else actor_names.get(actor_id)
                if actor_id is not None
                else "System"
            )
            grouped_events[key] = {
                "revoked_at": revoked_at,
                "revoked_by_user_id": actor_id,
                "revoked_by_name": actor_name,
                "revoke_scope": session_row.revoke_scope,
                "revoke_reason": session_row.revoke_reason,
                "session_count": 0,
                "devices": [],
                "forced_by_other_user": actor_id is not None and actor_id != current_user.id,
            }

        grouped_events[key]["session_count"] += 1
        device_label = (session_row.device or "").strip()
        if device_label and device_label not in grouped_events[key]["devices"]:
            grouped_events[key]["devices"].append(device_label)

    events = list(grouped_events.values())
    events.sort(key=lambda item: item["revoked_at"], reverse=True)
    return events[:safe_limit]


# --- Mobile OTP (employee verification) --------------------------------------

MOBILE_OTP_EXPIRY_MINUTES = 10
MOBILE_OTP_MAX_ATTEMPTS   = 5


class MobileOtpSendRequest(BaseModel):
    employee_code: str
    email: str


class MobileOtpSendResponse(BaseModel):
    token: str
    message: str
    email_masked: str
    expires_in_seconds: int


class MobileOtpVerifyRequest(BaseModel):
    employee_code: str
    otp: str
    token: str


class MobileOtpVerifyResponse(BaseModel):
    success: bool
    message: str


@router.post("/mobile/send-otp", response_model=MobileOtpSendResponse)
def mobile_send_otp(
    data: MobileOtpSendRequest,
    request: Request,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
):
    """Send a 6-digit OTP to the employee's registered email for mobile verification."""
    tenant_slug = _resolve_tenant_slug(request)
    request.state.tenant_slug = tenant_slug
    ip = get_request_ip(request)

    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")

    employee_code = (data.employee_code or "").strip()
    email_input   = (data.email or "").strip().lower()

    if not employee_code:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Employee code is required")
    if not email_input:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email is required")

    # Resolve user by employee_code
    user = db.query(User).filter(
        User.employee_code == employee_code,
        User.is_active == True,
    ).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="Employee not found or inactive")

    _ensure_login_otp_schema(db)
    _cleanup_stale_login_otp_challenges(db)

    # Invalidate any open challenges for this user
    db.query(LoginOTPChallenge).filter(
        LoginOTPChallenge.user_id == user.id,
        LoginOTPChallenge.consumed_at.is_(None),
    ).delete(synchronize_session=False)

    challenge_id = secrets.token_urlsafe(24)
    otp_code     = _generate_login_otp_code()
    now          = _utcnow_naive()

    challenge = LoginOTPChallenge(
        challenge_id    = challenge_id,
        user_id         = user.id,
        username        = user.username,
        otp_hash        = _hash_login_otp(challenge_id, otp_code),
        remember_me     = False,
        ip_address      = ip,
        user_agent      = "Mobile App",
        fcm_token       = None,
        failed_attempts = 0,
        resend_count    = 0,
        expires_at      = now + timedelta(minutes=MOBILE_OTP_EXPIRY_MINUTES),
        sent_at         = now,
    )
    db.add(challenge)

    display_name = user.full_name or user.username or "User"
    tenant_name  = tenant.name or tenant.slug or "your company"
    text_body = (
        f"Hello {display_name},\n\n"
        f"Your {tenant_name} verification code is: {otp_code}\n\n"
        f"This code expires in {MOBILE_OTP_EXPIRY_MINUTES} minute(s).\n"
        "If you did not request this code, please contact your administrator."
    )
    html_body = f"""
    <html>
      <body style="font-family: Arial, sans-serif; color: #0f172a;">
        <p>Hello {display_name},</p>
        <p>Your <strong>{tenant_name}</strong> verification code is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 0.18em; margin: 20px 0;">{otp_code}</p>
        <p>This code expires in {MOBILE_OTP_EXPIRY_MINUTES} minute(s).</p>
        <p>If you did not request this code, please contact your administrator.</p>
      </body>
    </html>
    """
    try:
        send_tenant_email(
            tenant    = tenant,
            to_email  = email_input,
            subject   = "Your verification code",
            text_body = text_body,
            html_body = html_body,
        )
    except TenantEmailConfigurationError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=str(exc) or "Email is not configured. Contact your administrator.") from exc
    except TenantEmailDeliveryError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="Unable to deliver the OTP email. Please try again.") from exc

    db.commit()
    log_auth_event("MOBILE_OTP_SENT", user.username, ip, True, f"employee_code={employee_code}")

    return MobileOtpSendResponse(
        token             = challenge_id,
        message           = "A verification code has been sent to your email address.",
        email_masked      = _mask_email_address(email_input),
        expires_in_seconds= MOBILE_OTP_EXPIRY_MINUTES * 60,
    )


@router.post("/mobile/verify-otp", response_model=MobileOtpVerifyResponse)
def mobile_verify_otp(
    data: MobileOtpVerifyRequest,
    request: Request,
    db: Session = Depends(get_tenant_db),
):
    """Verify a previously issued mobile OTP against the stored challenge token."""
    tenant_slug = _resolve_tenant_slug(request)
    request.state.tenant_slug = tenant_slug
    ip = get_request_ip(request)

    employee_code = (data.employee_code or "").strip()
    token         = (data.token or "").strip()
    otp           = (data.otp or "").strip()

    if not employee_code or not token or not otp:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="employee_code, otp, and token are all required")

    _ensure_login_otp_schema(db)
    _cleanup_stale_login_otp_challenges(db)

    challenge = db.query(LoginOTPChallenge).filter(
        LoginOTPChallenge.challenge_id == token,
    ).first()

    if not challenge or challenge.consumed_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="Verification session not found or already used.")

    now = _utcnow_naive()
    if challenge.expires_at < now:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Verification code has expired. Please request a new OTP.")

    # Confirm the challenge belongs to the claimed employee
    user = db.query(User).filter(
        User.id == challenge.user_id,
        User.is_active == True,
    ).first()
    if not user or (getattr(user, "username", None) or "").strip() != employee_code:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Employee code does not match this verification session.")
    _enforce_platform_block(request, user)
    _enforce_mobile_policy(request, user)

    # Guard against brute-force
    if int(challenge.failed_attempts or 0) >= MOBILE_OTP_MAX_ATTEMPTS:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Too many failed attempts. Please request a new OTP.")

    normalized_otp = _normalize_otp_code(otp)
    if not _login_otp_matches(challenge, normalized_otp):
        challenge.failed_attempts = int(challenge.failed_attempts or 0) + 1
        db.commit()
        remaining = max(0, MOBILE_OTP_MAX_ATTEMPTS - int(challenge.failed_attempts))
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"Invalid verification code. {remaining} attempt(s) remaining.")

    challenge.consumed_at = now
    db.commit()

    log_auth_event("MOBILE_OTP_VERIFIED", user.username, ip, True, f"employee_code={employee_code}")

    return MobileOtpVerifyResponse(success=True, message="OTP verified successfully.")


# --- User management ----------------------------------------------------------

@router.get("/users", response_model=List[UserListResponse])
def list_users(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _require_user_admin(cu)
    if cu.role == 'manager':
        users = db.query(User).filter(
            (User.reporting_manager_id == cu.id) | (User.id == cu.id)
        ).all()
    else:
        users = db.query(User).all()

    return _enrich_users(users, db)


@router.get("/users/{user_id}", response_model=UserResponse)
def get_user(
    user_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """One user for the edit form (same shape as the list / update responses)."""
    _require_user_admin(cu)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    if cu.role == "manager" and user.reporting_manager_id != cu.id and user.id != cu.id:
        raise HTTPException(403, "You can only view your own team")
    return _serialize_user_response(user, db)


@router.post("/users/logout-selected")
def logout_selected_users(
    payload: BulkUserLogoutPayload,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    _require_user_admin(cu)

    user_ids = sorted({int(user_id) for user_id in payload.user_ids if user_id})
    if not user_ids:
        raise HTTPException(400, "Select at least one user")

    query = db.query(User).filter(User.id.in_(user_ids))
    if cu.role == 'manager':
        query = query.filter((User.reporting_manager_id == cu.id) | (User.id == cu.id))

    target_users = query.all()
    target_user_ids = sorted(user.id for user in target_users)
    if len(target_user_ids) != len(user_ids):
        raise HTTPException(403, "One or more selected users were not found or are not allowed")

    cutoff = _istnow_naive()
    current_session_jti = _get_request_session_jti(request)
    current_session_kept = cu.id in target_user_ids and bool(current_session_jti)
    require_password_reset = bool(payload.require_password_reset)
    for target_user in target_users:
        if target_user.id != cu.id or not current_session_kept:
            target_user.force_logout_after = cutoff
        if require_password_reset:
            target_user.must_change_password = True

    revoke_reason = (
        f"Forced logout by {cu.full_name or cu.username}. Password reset required on next login."
        if require_password_reset
        else f"Forced logout by {cu.full_name or cu.username}"
    )

    revoked_sessions = _revoke_user_sessions(
        db,
        target_user_ids,
        revoked_by_user_id=cu.id,
        revoke_reason=revoke_reason,
        revoke_scope="selected",
        exclude_session_jti=current_session_jti if current_session_kept else None,
    )
    log_audit_db(
        db,
        cu.id,
        "auth",
        "logout_selected_users",
        None,
        get_request_ip(request),
        description=f"{cu.full_name or cu.username} logged out {len(target_user_ids)} selected user(s)",
        new_data={
            "scope": "selected_users",
            "affected_user_ids": target_user_ids,
            "affected_user_count": len(target_user_ids),
            "revoked_session_count": revoked_sessions,
            "force_logout_after": cutoff.isoformat(),
            "require_password_reset": require_password_reset,
            "current_session_kept": current_session_kept,
        },
    )
    db.commit()
    log_auth_event("LOGOUT_SELECTED_USERS", cu.username, get_request_ip(request), True, f"count={len(target_user_ids)}")
    log_audit(None, cu.id, "auth", "logout_selected_users", get_request_ip(request), f"count={len(target_user_ids)}")
    if require_password_reset:
        message = f"Logged out {len(target_user_ids)} selected user(s) and required password reset on next login"
    else:
        message = f"Logged out {len(target_user_ids)} selected user(s) successfully"
    if current_session_kept:
        message += ". Your current device stayed signed in."
    return {
        "message": message,
        "affected_user_ids": target_user_ids,
        "affected_user_count": len(target_user_ids),
        "revoked_session_count": revoked_sessions,
        "require_password_reset": require_password_reset,
        "current_session_kept": current_session_kept,
    }


@router.post("/users/logout-all")
def logout_all_users_in_tenant(
    request: Request,
    payload: Optional[TenantForceLogoutPayload] = None,
    db: Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ('admin', 'ceo'):
        raise HTTPException(403, "Only Admin or CEO can log out all users in the tenant")

    cutoff = _istnow_naive()
    current_session_jti = _get_request_session_jti(request)
    current_session_kept = bool(current_session_jti)
    require_password_reset = bool(payload.require_password_reset) if payload is not None else False
    target_users = db.query(User).all()
    target_user_ids = [user.id for user in target_users]
    for target_user in target_users:
        if target_user.id != cu.id or not current_session_kept:
            target_user.force_logout_after = cutoff
        if require_password_reset:
            target_user.must_change_password = True

    revoke_reason = (
        f"Tenant-wide forced logout by {cu.full_name or cu.username}. Password reset required on next login."
        if require_password_reset
        else f"Tenant-wide forced logout by {cu.full_name or cu.username}"
    )

    revoked_sessions = _revoke_user_sessions(
        db,
        target_user_ids,
        revoked_by_user_id=cu.id,
        revoke_reason=revoke_reason,
        revoke_scope="tenant",
        exclude_session_jti=current_session_jti if current_session_kept else None,
    )

    tenant_slug = _resolve_tenant_slug(request)
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if tenant and not current_session_kept:
        tenant.force_logout_after = cutoff

    log_audit_db(
        db,
        cu.id,
        "auth",
        "logout_all_users",
        None,
        get_request_ip(request),
        description=f"{cu.full_name or cu.username} logged out all tenant users",
        new_data={
            "scope": "tenant_users",
            "affected_user_ids": target_user_ids,
            "affected_user_count": len(target_user_ids),
            "revoked_session_count": revoked_sessions,
            "force_logout_after": cutoff.isoformat(),
            "require_password_reset": require_password_reset,
            "tenant_slug": tenant_slug,
            "current_session_kept": current_session_kept,
        },
    )
    db.commit()

    if tenant:
        try:
            master_db.commit()
        except Exception as exc:
            master_db.rollback()
            logger.warning("Tenant-wide logout master sync failed for tenant=%s: %s", tenant_slug, exc)

    log_auth_event("LOGOUT_ALL_USERS", cu.username, get_request_ip(request), True, f"tenant={tenant_slug} count={len(target_user_ids)}")
    log_audit(None, cu.id, "auth", "logout_all_users", get_request_ip(request), f"tenant={tenant_slug} count={len(target_user_ids)}")
    if require_password_reset:
        message = "Logged out all tenant users and required password reset on next login"
    else:
        message = "Logged out all tenant users successfully"
    if current_session_kept:
        message += ". Your current device stayed signed in."
    return {
        "message": message,
        "affected_user_ids": target_user_ids,
        "affected_user_count": len(target_user_ids),
        "revoked_session_count": revoked_sessions,
        "require_password_reset": require_password_reset,
        "current_session_kept": current_session_kept,
    }

@router.get("/groups/{group_id}/reporting-hierarchy")
def get_group_reporting_hierarchy_for_user_form(
    group_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    _require_user_admin(cu)

    rows = db.query(UserReportingHierarchy).filter(
        UserReportingHierarchy.group_id == group_id,
        UserReportingHierarchy.is_active == True,
    ).order_by(UserReportingHierarchy.level.asc()).all()

    reporting_user_ids = {
        int(row.reporting_user_id)
        for row in rows
        if row.reporting_user_id
    }
    reporting_users = {
        int(user.id): user
        for user in db.query(User).filter(
            User.id.in_(reporting_user_ids),
            User.is_active == True,
        ).all()
    } if reporting_user_ids else {}
    result = []

    for row in rows:
        reporting_user = reporting_users.get(int(row.reporting_user_id)) if row.reporting_user_id else None

        result.append({
            "id": row.id,
            "group_id": row.group_id,
            "reporting_user_id": row.reporting_user_id,
            "reporting_role": row.reporting_role,
            "level": row.level,
            "user_name": reporting_user.full_name if reporting_user else "",
            "user_role": reporting_user.role if reporting_user else "",
            "email": reporting_user.email if reporting_user else "",
        })

    return result


@router.post("/users", response_model=UserResponse, status_code=201)
def create_user(
    data:    UserCreate,
    request: Request,
    db:      Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    cu:      User    = Depends(get_current_user),
):
    _require_user_admin(cu)

    if db.query(User).filter(User.username == data.username).first():
        raise HTTPException(400, "Username already exists")
    if db.query(User).filter(User.email == data.email).first():
        raise HTTPException(400, "Email already exists")
    if data.confirm_password is not None and data.password != data.confirm_password:
        raise HTTPException(400, "Password and confirm password must match")
    
    role_row = db.query(Role).filter(
        Role.name == data.role,
        Role.is_active == True,
    ).first()

    if not role_row:
        raise HTTPException(400, "Selected role does not exist or is inactive")

    valid, msg = validate_password_strength(data.password)
    if not valid:
        raise HTTPException(400, msg)

    region_id = data.region_id if data.role in REGION_GROUP_ROLES else None
    state_id  = data.state_id  if data.role in REGION_GROUP_ROLES else None
    group_id  = data.group_id  if data.role in REGION_GROUP_ROLES else None
    target    = data.target    if data.role in TARGET_ROLES        else None

    # Reporting manager always comes from group fixing — do not set manually
    reporting_manager_id  = None
    reporting_manager_ids = None
    tenant_slug = _resolve_tenant_slug(request)
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(404, "Tenant not found")

    active_count = db.query(User).filter(User.is_active == True).count()
    if active_count >= tenant.max_users:
        raise HTTPException(
            403,
            f"User limit reached. This account allows a maximum of {tenant.max_users} active users. "
            "Please contact your administrator to increase the limit.",
        )

    user = User(
        username              = data.username,
        email                 = data.email,
        full_name             = data.full_name,
        hashed_password       = hash_password(data.password),
        last_password_changed_at = _istnow_naive(),
        must_change_password  = bool(getattr(tenant, 'force_password_change_on_first_login', False)),
        role                  = data.role,
        department            = data.department,
        designation           = data.designation,
        phone                 = data.phone,
        branch                = data.branch,
        employee_code         = data.employee_code,
        reporting_manager_id  = reporting_manager_id,
        reporting_manager_ids = reporting_manager_ids,
        region_id             = region_id,
        state_id              = state_id,
        group_id              = group_id,
        target                = target,
    )
    db.add(user)
    db.flush()
    log_audit(None, cu.id, "users", "create", get_request_ip(request),
              f"created user {data.username} role={data.role}")
    log_module_action(
        db=db, user_id=cu.id, module="users", action="create",
        record_id=user.id, record_name=user.full_name, ip=get_request_ip(request),
        new_data={
            "username": user.username, "email": user.email, "role": user.role,
            "department": user.department, "designation": user.designation,
        },
    )
    db.commit()
    db.refresh(user)
    return _serialize_user_response(user, db)

@router.put("/users/{user_id}", response_model=UserResponse)
def update_user(
    user_id: int,
    data:    UserUpdate,
    request: Request,
    db:      Session = Depends(get_tenant_db),
    cu:      User    = Depends(get_current_user),
):
    _require_user_admin(cu)

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")

    # if cu.role == 'manager' and data.role in ('admin', 'ceo', 'vp', 'manager'):
    #     raise HTTPException(403, "Managers cannot assign senior roles")

    updates  = data.model_dump(exclude_unset=True)
    new_role = updates.get("role", user.role)
    old_role = user.role
    old_is_active = user.is_active

    if "password" in updates:
        pwd = updates.pop("password")
        if pwd:
            valid, msg = validate_password_strength(pwd)
            if not valid:
                raise HTTPException(400, msg)
            user.hashed_password = hash_password(pwd)
            user.last_password_changed_at = _istnow_naive()
            user.must_change_password = user.id != cu.id

    if new_role not in REGION_GROUP_ROLES:
        updates["region_id"] = None
        updates["state_id"]  = None
        updates["group_id"]  = None

    if new_role not in TARGET_ROLES:
        updates["target"] = None

    # Reporting manager comes from group fixing — clear both on every update
    updates.pop("reporting_manager_ids", None)
    updates.pop("reporting_manager_id",  None)
    updates["reporting_manager_id"]  = None
    updates["reporting_manager_ids"] = None

    for field, val in updates.items():
        if hasattr(user, field):
            setattr(user, field, val)

    log_audit(None, cu.id, "users", "update", get_request_ip(request), f"updated user {user_id}")
    safe_updates = {k: v for k, v in updates.items() if k != "password"}
    log_module_action(
        db=db, user_id=cu.id, module="users", action="update",
        record_id=user.id, record_name=user.full_name, ip=get_request_ip(request),
        new_data=safe_updates,
    )
    if "is_active" in updates and user.is_active != old_is_active:
        log_module_action(
            db=db, user_id=cu.id, module="users",
            action="activate" if user.is_active else "deactivate",
            record_id=user.id, record_name=user.full_name, ip=get_request_ip(request),
            old_data={"is_active": old_is_active}, new_data={"is_active": user.is_active},
        )
    if "role" in updates and new_role != old_role:
        log_module_action(
            db=db, user_id=cu.id, module="users", action="role_change",
            record_id=user.id, record_name=user.full_name, ip=get_request_ip(request),
            old_data={"role": old_role}, new_data={"role": new_role},
        )
    db.commit()
    db.refresh(user)
    return _serialize_user_response(user, db)


@router.delete("/users/{user_id}")
def deactivate_user(
    user_id: int,
    request: Request,
    db:      Session = Depends(get_tenant_db),
    cu:      User    = Depends(get_current_user),
):
    _require_user_admin(cu)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    if user.id == cu.id:
        raise HTTPException(400, "Cannot deactivate your own account")
    user.is_active = False
    log_audit(None, cu.id, "users", "deactivate", get_request_ip(request), f"deactivated user {user_id}")
    log_module_action(
        db=db, user_id=cu.id, module="users", action="deactivate",
        record_id=user.id, record_name=user.full_name, ip=get_request_ip(request),
    )
    db.commit()
    return {"message": "User deactivated"}


@router.post("/users/{user_id}/reset-password")
def reset_user_password(
    user_id: int,
    payload: ResetPasswordPayload,
    request: Request,
    db:      Session = Depends(get_tenant_db),
    master_db: Session = Depends(get_master_db_dep),
    cu:      User    = Depends(get_current_user),
):
    _require_user_admin(cu)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    if payload.confirm_password is not None and payload.new_password != payload.confirm_password:
        raise HTTPException(400, "New password and confirm password must match")
    valid, msg = validate_password_strength(payload.new_password)
    if not valid:
        raise HTTPException(400, msg)
    user.hashed_password = hash_password(payload.new_password)
    user.last_password_changed_at = _istnow_naive()
    user.must_change_password = user.id != cu.id
    db.commit()
    tenant_slug = _resolve_tenant_slug(request)
    send_admin_password_changed_notification(
        master_db,
        tenant_slug=tenant_slug,
        user_id=user.id,
        actor_name=cu.full_name or cu.username,
    )
    log_audit(None, cu.id, "users", "reset_password", get_request_ip(request),
              f"reset password for user {user_id}")
    return {"message": "Password reset successfully"}


@router.post("/users/{user_id}/send-reset-link")
def send_user_reset_link(
    user_id: int,
    request: Request,
    master_db: Session = Depends(get_master_db_dep),
    cu: User = Depends(get_current_user),
):
    _require_user_admin(cu)
    tenant_slug = _resolve_tenant_slug(request)

    try:
        target = send_admin_password_reset_link(
            master_db,
            request,
            tenant_slug=tenant_slug,
            user_id=user_id,
        )
    except PasswordResetError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    log_audit(None, cu.id, "users", "send_reset_link", get_request_ip(request),
              f"sent admin reset link for user {target.user_id}")
    return {"message": "Password reset link sent successfully"}


# --- Customer Assignment -------------------------------------------------------

@router.get("/users/{user_id}/customers", response_model=List[CustomerAssignResponse])
def get_user_customers(
    user_id: int,
    db:      Session = Depends(get_tenant_db),
    cu:      User    = Depends(get_current_user),
):
    """Return customers currently assigned to this user."""
    _require_user_admin(cu)
    _get_assignable_user(user_id, db, cu)

    owner_map = _effective_customer_owner_map(db)
    customer_ids = [customer_id for customer_id, owner_user_id in owner_map.items() if owner_user_id == user_id]
    if not customer_ids:
        return []
    return db.query(Customer).filter(Customer.id.in_(customer_ids)).all()


@router.get("/users/{user_id}/available-customers", response_model=List[CustomerAssignResponse])
def get_available_customers(
    user_id: int,
    db:      Session = Depends(get_tenant_db),
    cu:      User    = Depends(get_current_user),
):
    """
    Return customers that are either:
      - Already assigned to this user  (shown as checked in the panel), OR
      - Not assigned to any user at all (shown as available to pick)

    Customers assigned to OTHER users are excluded entirely; they are not
    available until the other user's assignment is removed.
    """
    _require_user_admin(cu)
    _get_assignable_user(user_id, db, cu)

    owner_map = _effective_customer_owner_map(db)
    all_customers = db.query(Customer).all()
    return [c for c in all_customers if owner_map.get(c.id) in (None, user_id)]


@router.put("/users/{user_id}/customers")
def assign_customers_bulk(
    user_id: int,
    payload: CustomerAssignPayload,
    request: Request,
    db:      Session = Depends(get_tenant_db),
    cu:      User    = Depends(get_current_user),
):
    """
    Replace this user's customer assignments with the supplied list.
    Only customers that are unassigned (or already belong to this user)
    are accepted; customers belonging to other users are rejected.
    """
    _require_user_admin(cu)
    _get_assignable_user(user_id, db, cu)

    if payload.customer_ids:
        # Validate all IDs exist
        found     = db.query(Customer.id).filter(Customer.id.in_(payload.customer_ids)).all()
        found_ids = {r.id for r in found}
        missing   = set(payload.customer_ids) - found_ids
        if missing:
            raise HTTPException(400, f"Customer IDs not found: {sorted(missing)}")

        owner_map = _effective_customer_owner_map(db)
        taken_ids = sorted([
            customer_id for customer_id in payload.customer_ids
            if owner_map.get(customer_id) not in (None, user_id)
        ])
        if taken_ids:
            raise HTTPException(
                400,
                f"Customer(s) {taken_ids} are already assigned to another user. "
                "Remove them from the other user first."
            )

    # Delete all existing assignments for this user and re-insert
    owner_map = _effective_customer_owner_map(db)
    existing_customer_ids = [
        customer_id for customer_id, owner_user_id in owner_map.items()
        if owner_user_id == user_id
    ]
    db.query(SalesCustomerAssignment).filter(
        SalesCustomerAssignment.user_id == user_id
    ).delete(synchronize_session="fetch")
    db.flush()

    now = _istnow_naive()
    for cid in payload.customer_ids:
        db.add(SalesCustomerAssignment(
            user_id     = user_id,
            customer_id = cid,
            assigned_by = cu.id,
            is_active   = True,
            updated_at  = now,
        ))

    next_customer_ids = set(payload.customer_ids or [])
    affected_customer_ids = set(existing_customer_ids) | next_customer_ids
    if affected_customer_ids:
        customers = db.query(Customer).filter(Customer.id.in_(affected_customer_ids)).all()
        for customer in customers:
            customer.assigned_to = user_id if customer.id in next_customer_ids else None

    log_audit(None, cu.id, "users", "assign_customers", get_request_ip(request),
              f"assigned {len(payload.customer_ids)} customers to user {user_id}")
    log_module_action(
        db=db, user_id=cu.id, module="customers", action="assign",
        record_id=None, record_name=f"{len(payload.customer_ids)} customer(s) → user #{user_id}",
        ip=get_request_ip(request),
        new_data={"user_id": user_id, "customer_ids": payload.customer_ids},
    )
    db.commit()
    return {
        "message": f"Assigned {len(payload.customer_ids)} customer(s)",
        "user_id": user_id,
        "count":   len(payload.customer_ids),
    }


@router.post("/users/{user_id}/customers/{customer_id}", status_code=201)
def assign_single_customer(
    user_id:     int,
    customer_id: int,
    request:     Request,
    db:          Session = Depends(get_tenant_db),
    cu:          User    = Depends(get_current_user),
):
    _require_user_admin(cu)
    _get_assignable_user(user_id, db, cu)

    customer = db.query(Customer).filter(Customer.id == customer_id).first()
    if not customer:
        raise HTTPException(404, "Customer not found")

    owner_map = _effective_customer_owner_map(db)
    current_owner_user_id = owner_map.get(customer_id)
    if current_owner_user_id not in (None, user_id):
        raise HTTPException(
            400,
            f"Customer is already assigned to another user (user_id={current_owner_user_id}). "
            "Remove it from the other user first."
        )

    existing = db.query(SalesCustomerAssignment).filter(
        SalesCustomerAssignment.user_id     == user_id,
        SalesCustomerAssignment.customer_id == customer_id,
    ).first()

    now = _istnow_naive()
    if existing:
        existing.is_active   = True
        existing.assigned_by = cu.id
        existing.updated_at  = now
    else:
        db.add(SalesCustomerAssignment(
            user_id     = user_id,
            customer_id = customer_id,
            assigned_by = cu.id,
            is_active   = True,
            updated_at  = now,
        ))

    customer.assigned_to = user_id

    log_audit(None, cu.id, "users", "assign_customer", get_request_ip(request),
              f"assigned customer {customer_id} to user {user_id}")
    log_module_action(
        db=db, user_id=cu.id, module="customers", action="assign",
        record_id=customer.id, record_name=customer.customer_name, ip=get_request_ip(request),
        new_data={"assigned_to": user_id},
    )
    db.commit()
    return {"message": "Customer assigned"}


@router.delete("/users/{user_id}/customers/{customer_id}")
def unassign_customer(
    user_id:     int,
    customer_id: int,
    request:     Request,
    db:          Session = Depends(get_tenant_db),
    cu:          User    = Depends(get_current_user),
):
    _require_user_admin(cu)
    _get_assignable_user(user_id, db, cu)

    row = db.query(SalesCustomerAssignment).filter(
        SalesCustomerAssignment.user_id     == user_id,
        SalesCustomerAssignment.customer_id == customer_id,
        SalesCustomerAssignment.is_active   == True,
    ).first()
    customer = db.query(Customer).filter(Customer.id == customer_id).first()
    if not row and not (customer and customer.assigned_to == user_id):
        raise HTTPException(404, "Assignment not found")

    if row:
        row.is_active = False
    if customer and customer.assigned_to == user_id:
        customer.assigned_to = None
    log_audit(None, cu.id, "users", "unassign_customer", get_request_ip(request),
              f"unassigned customer {customer_id} from user {user_id}")
    log_module_action(
        db=db, user_id=cu.id, module="customers", action="assign",
        record_id=customer_id, record_name=customer.customer_name if customer else None,
        ip=get_request_ip(request), new_data={"assigned_to": None},
    )
    db.commit()
    return {"message": "Customer unassigned"}


