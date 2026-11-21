import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from app.core.timezone import as_ist_naive, now_ist, today_ist
from html import escape
from urllib.parse import urlencode, urlsplit

from fastapi import Request
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import (
    create_password_reset_token,
    hash_password,
    password_reset_token_fingerprint,
    validate_password_strength,
    verify_password_reset_token,
)
from app.database import get_tenant_session, normalize_tenant_slug
from app.dependencies import get_request_ip
from app.models.tenant import Tenant, ForgotPasswordSendAttempt
from app.models.user import User
from app.services.tenant_email_service import (
    TenantEmailConfigurationError,
    TenantEmailDeliveryError,
    send_tenant_email,
)

logger = logging.getLogger(__name__)

RESET_PATH = "/reset-password"
ACTIVE_PASSWORD_RESET_TENANT_STATUSES = {"active", "trial"}
RESET_LIMIT_EXCEEDED_MESSAGE = (
    "Password reset is allowed only within the configured limit. "
    "Please contact your administrator for further access."
)
PASSWORD_EXPIRED_MESSAGE = "Your password has expired. Please reset or change your password to continue."
CONTACT_ADMIN_SUCCESS_MESSAGE = "Your request has been sent to the administrator."
FORGOT_PASSWORD_GENERIC_SUCCESS_MESSAGE = "If an account exists for this email, a reset link has been sent."
FORGOT_PASSWORD_RATE_LIMIT_MESSAGE = "Too many forgot-password requests. Please try again later."
DEFAULT_FORGOT_PASSWORD_SEND_MAX_ATTEMPTS = 5
DEFAULT_FORGOT_PASSWORD_SEND_WINDOW_MINUTES = 15
DEFAULT_FORGOT_PASSWORD_IP_MAX_ATTEMPTS = 10
DEFAULT_FORGOT_PASSWORD_IP_WINDOW_MINUTES = 15
MASKED_FORGOT_PASSWORD_MESSAGES = (
    "No user found with this email address.",
    "Multiple accounts are associated with this email.",
)
RESERVED_TENANT_SUBDOMAINS = {"www", "api", "app", "mail", "admin", "staging", "dev", "test", "localhost"}
PASSWORD_RESET_PURPOSE_FORGOT_PASSWORD = "forgot_password"
PASSWORD_RESET_PURPOSE_PASSWORD_EXPIRED = "password_expired"
PASSWORD_RESET_PURPOSE_ADMIN = "admin_reset"
FIRST_LOGIN_PASSWORD_CHANGE_WINDOW = timedelta(minutes=5)


class PasswordResetError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


@dataclass
class PasswordResetTarget:
    tenant: Tenant
    user_id: int
    email: str
    full_name: str
    username: str
    employee_code: str | None
    is_active: bool
    password_fingerprint: str


@dataclass
class PasswordResetResult:
    tenant: Tenant
    user_id: int
    email: str


@dataclass
class PasswordChangeRequirementResult:
    password_expired: bool
    must_change_password: bool
    reset_token: str | None = None


def _utcnow() -> datetime:
    return now_ist()


def _as_utc(value: datetime | None) -> datetime | None:
    return as_ist_naive(value)


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _extract_tenant_slug_from_host_value(value: str | None) -> str | None:
    if not value:
        return None

    host_value = value.split(",")[0].strip()
    if not host_value:
        return None

    if "://" in host_value:
        parsed = urlsplit(host_value)
        host_value = parsed.netloc or parsed.path

    host = host_value.split(":")[0].strip().lower()
    if not host:
        return None

    parts = host.split(".")
    if len(parts) < 2:
        return None

    candidate = parts[0]
    if candidate in RESERVED_TENANT_SUBDOMAINS:
        return None

    try:
        return normalize_tenant_slug(candidate)
    except ValueError:
        return None


def _resolve_forgot_password_tenant(master_db: Session, request: Request) -> Tenant | None:
    candidates = [
        getattr(request.state, "tenant_slug", None),
        request.headers.get("x-tenant-slug", "").strip() or None,
        request.query_params.get("tenant", "").strip() or None,
        _extract_tenant_slug_from_host_value(request.headers.get("x-forwarded-host")),
        _extract_tenant_slug_from_host_value(request.headers.get("host")),
        _extract_tenant_slug_from_host_value(request.headers.get("origin")),
        _extract_tenant_slug_from_host_value(request.headers.get("referer")),
        _extract_tenant_slug_from_host_value(getattr(request.url, "hostname", None)),
    ]

    for candidate in candidates:
        if not candidate:
            continue
        tenant = master_db.query(Tenant).filter(Tenant.slug == candidate).first()
        if tenant:
            return tenant

    return None


def _tenant_forgot_password_send_max_attempts(tenant: Tenant | None) -> int:
    value = getattr(tenant, "forgot_password_send_max_attempts", DEFAULT_FORGOT_PASSWORD_SEND_MAX_ATTEMPTS)
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return DEFAULT_FORGOT_PASSWORD_SEND_MAX_ATTEMPTS


def _tenant_forgot_password_send_window_minutes(tenant: Tenant | None) -> int:
    value = getattr(tenant, "forgot_password_send_window_minutes", DEFAULT_FORGOT_PASSWORD_SEND_WINDOW_MINUTES)
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return DEFAULT_FORGOT_PASSWORD_SEND_WINDOW_MINUTES


def _tenant_forgot_password_ip_max_attempts(tenant: Tenant | None) -> int:
    value = getattr(tenant, "forgot_password_ip_max_attempts", DEFAULT_FORGOT_PASSWORD_IP_MAX_ATTEMPTS)
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return DEFAULT_FORGOT_PASSWORD_IP_MAX_ATTEMPTS


def _tenant_forgot_password_ip_window_minutes(tenant: Tenant | None) -> int:
    value = getattr(tenant, "forgot_password_ip_window_minutes", DEFAULT_FORGOT_PASSWORD_IP_WINDOW_MINUTES)
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return DEFAULT_FORGOT_PASSWORD_IP_WINDOW_MINUTES


def _forgot_password_attempt_count(
    master_db: Session,
    *,
    tenant_id: int | None,
    normalized_email: str | None = None,
    ip_address: str | None = None,
    since: datetime,
) -> int:
    query = master_db.query(func.count(ForgotPasswordSendAttempt.id)).filter(
        ForgotPasswordSendAttempt.created_at >= since
    )
    if tenant_id is None:
        query = query.filter(ForgotPasswordSendAttempt.tenant_id.is_(None))
    else:
        query = query.filter(ForgotPasswordSendAttempt.tenant_id == tenant_id)

    if normalized_email is not None:
        query = query.filter(ForgotPasswordSendAttempt.normalized_email == normalized_email)
    if ip_address is not None:
        query = query.filter(ForgotPasswordSendAttempt.ip_address == ip_address)

    return int(query.scalar() or 0)


def protect_forgot_password_send_attempt(
    master_db: Session,
    request: Request,
    email: str,
) -> ForgotPasswordSendAttempt:
    normalized_email = _normalize_email(email)
    ip_address = get_request_ip(request)
    tenant = _resolve_forgot_password_tenant(master_db, request)
    tenant_id = tenant.id if tenant else None
    now = _utcnow()

    email_window_start = now - timedelta(minutes=_tenant_forgot_password_send_window_minutes(tenant))
    ip_window_start = now - timedelta(minutes=_tenant_forgot_password_ip_window_minutes(tenant))

    email_attempt_count = _forgot_password_attempt_count(
        master_db,
        tenant_id=tenant_id,
        normalized_email=normalized_email,
        since=email_window_start,
    )
    if email_attempt_count >= _tenant_forgot_password_send_max_attempts(tenant):
        raise PasswordResetError(FORGOT_PASSWORD_RATE_LIMIT_MESSAGE, status_code=429)

    ip_attempt_count = _forgot_password_attempt_count(
        master_db,
        tenant_id=tenant_id,
        ip_address=ip_address,
        since=ip_window_start,
    )
    if ip_attempt_count >= _tenant_forgot_password_ip_max_attempts(tenant):
        raise PasswordResetError(FORGOT_PASSWORD_RATE_LIMIT_MESSAGE, status_code=429)

    attempt = ForgotPasswordSendAttempt(
        tenant_id=tenant_id,
        normalized_email=normalized_email,
        ip_address=ip_address,
        created_at=now,
    )
    master_db.add(attempt)
    master_db.commit()
    return attempt


def assign_forgot_password_attempt_tenant(
    master_db: Session,
    attempt: ForgotPasswordSendAttempt | None,
    tenant_id: int | None,
) -> None:
    if attempt is None or tenant_id is None:
        return

    if getattr(attempt, "tenant_id", None) == tenant_id:
        return

    try:
        attempt.tenant_id = tenant_id
        master_db.commit()
    except Exception as exc:
        master_db.rollback()
        logger.warning(
            "Unable to backfill forgot-password attempt tenant_id for attempt=%s: %s",
            getattr(attempt, "id", None),
            exc,
        )


def should_mask_forgot_password_error(exc: PasswordResetError) -> bool:
    message = (exc.message or "").strip()
    return any(message.startswith(masked_message) for masked_message in MASKED_FORGOT_PASSWORD_MESSAGES)


def _resolve_frontend_base_url(request: Request) -> str:
    origin = (request.headers.get("origin") or "").strip()
    if origin:
        return origin.rstrip("/")

    referer = (request.headers.get("referer") or "").strip()
    if referer:
        parsed = urlsplit(referer)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"

    if settings.ALLOWED_ORIGINS:
        return settings.ALLOWED_ORIGINS[0].rstrip("/")

    return str(request.base_url).rstrip("/")


def build_password_reset_url(request: Request, token: str) -> str:
    base_url = _resolve_frontend_base_url(request)
    query = urlencode({"token": token})
    return f"{base_url}{RESET_PATH}?{query}"


def _tenant_reset_limit_count(tenant: Tenant) -> int:
    value = getattr(tenant, "self_service_reset_limit_count", 1)
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 1


def _tenant_reset_limit_days(tenant: Tenant) -> int:
    value = getattr(tenant, "self_service_reset_limit_days", 30)
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return 30


def _password_reset_purpose(payload: dict | None) -> str:
    purpose = str((payload or {}).get("purpose") or PASSWORD_RESET_PURPOSE_FORGOT_PASSWORD).strip().lower()
    return purpose or PASSWORD_RESET_PURPOSE_FORGOT_PASSWORD


def _password_reset_counts_toward_self_service_limit(payload: dict | None) -> bool:
    return _password_reset_purpose(payload) == PASSWORD_RESET_PURPOSE_FORGOT_PASSWORD


def _tenant_password_expiry_days(tenant: Tenant) -> int:
    value = getattr(tenant, "password_expiry_days", 30)
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return 30


def _build_target_from_user(tenant: Tenant, user: User) -> PasswordResetTarget:
    return PasswordResetTarget(
        tenant=tenant,
        user_id=user.id,
        email=user.email,
        full_name=user.full_name,
        username=user.username,
        employee_code=getattr(user, "employee_code", None),
        is_active=bool(user.is_active),
        password_fingerprint=password_reset_token_fingerprint(user.hashed_password),
    )


def _find_password_reset_targets(
    master_db: Session,
    email: str,
    employee_code: str | None = None,
) -> list[PasswordResetTarget]:
    normalized_email = _normalize_email(email)
    normalized_code = (employee_code or "").strip() or None
    targets: list[PasswordResetTarget] = []
    lookup_errors = 0

    for tenant in master_db.query(Tenant).all():
        tenant_db = None
        try:
            tenant_db = get_tenant_session(tenant.slug)
            query = tenant_db.query(User).filter(func.lower(User.email) == normalized_email)
            if normalized_code:
                query = query.filter(User.employee_code == normalized_code)
            user = query.first()
            if user:
                targets.append(_build_target_from_user(tenant, user))
        except Exception as exc:
            lookup_errors += 1
            logger.warning("Forgot-password lookup failed for tenant=%s: %s", tenant.slug, exc)
        finally:
            if tenant_db is not None:
                tenant_db.close()

    if targets:
        return targets

    if lookup_errors:
        raise PasswordResetError(
            "Unable to verify email at the moment. Please try again later.",
            status_code=503,
        )

    return []


def _find_contact_administrator_target(
    master_db: Session,
    *,
    email: str | None = None,
    tenant_slug: str | None = None,
    username: str | None = None,
) -> PasswordResetTarget:
    normalized_email = (email or "").strip()
    normalized_tenant_slug = (tenant_slug or "").strip().lower()
    normalized_username = (username or "").strip()

    if normalized_email:
        targets = _find_password_reset_targets(master_db, normalized_email)
        if not targets:
            raise PasswordResetError("No matching user found for this request.", status_code=404)
        if len(targets) > 1:
            raise PasswordResetError(
                "Multiple accounts are associated with this email. Please contact your administrator directly."
            )
        return targets[0]

    if not normalized_tenant_slug or not normalized_username:
        raise PasswordResetError("Please provide your organisation and username to contact the administrator.")

    tenant = master_db.query(Tenant).filter(Tenant.slug == normalized_tenant_slug).first()
    if not tenant:
        raise PasswordResetError("No matching user found for this request.", status_code=404)

    tenant_db = None
    try:
        tenant_db = get_tenant_session(tenant.slug)
        user = tenant_db.query(User).filter(User.username == normalized_username).first()
        if not user:
            raise PasswordResetError("No matching user found for this request.", status_code=404)
        return _build_target_from_user(tenant, user)
    finally:
        if tenant_db is not None:
            tenant_db.close()


def _ensure_password_reset_allowed(target: PasswordResetTarget) -> None:
    if not target.is_active:
        raise PasswordResetError("User account is inactive. Please contact your administrator.")

    if target.tenant.status not in ACTIVE_PASSWORD_RESET_TENANT_STATUSES:
        raise PasswordResetError("Company account is inactive. Please contact your administrator.")

    if not getattr(target.tenant, "forgot_password_enabled", True):
        raise PasswordResetError("Forgot password is disabled for this company.")


def _build_reset_email_text(
    full_name: str,
    tenant_name: str,
    reset_url: str,
    intro_line: str,
) -> str:
    return (
        f"Hello {full_name or 'User'},\n\n"
        f"{intro_line}\n"
        f"Use the link below to reset your password:\n\n{reset_url}\n\n"
        f"This link will expire in {settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES} minutes.\n"
        "If you did not request this, you can ignore this email."
    )


def _build_reset_email_html(
    full_name: str,
    tenant_name: str,
    reset_url: str,
    intro_line: str,
) -> str:
    safe_name = escape(full_name or "User")
    safe_url = escape(reset_url, quote=True)
    safe_intro = escape(intro_line)
    expires_in = settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES
    return f"""
<html>
  <body style="font-family: Arial, sans-serif; color: #111827;">
    <p>Hello {safe_name},</p>
    <p>{safe_intro}</p>
    <p>
      <a href="{safe_url}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;">
        Reset Password
      </a>
    </p>
    <p>If the button does not work, copy and paste this link into your browser:</p>
    <p><a href="{safe_url}">{safe_url}</a></p>
    <p>This link will expire in {expires_in} minutes.</p>
    <p>If you did not request this, you can ignore this email.</p>
  </body>
</html>
""".strip()


def _build_contact_admin_text(target: PasswordResetTarget, requested_at: datetime) -> str:
    requested_at_text = requested_at.strftime("%Y-%m-%d %H:%M:%S UTC")
    lines = [
        "A password reset assistance request was submitted.",
        "",
        f"Tenant/Company: {target.tenant.name}",
        f"User Name: {target.full_name or target.username}",
        f"Username: {target.username}",
        f"Email: {target.email}",
    ]
    if target.employee_code:
        lines.append(f"Employee ID: {target.employee_code}")
    lines.extend(
        [
            f"Request Time: {requested_at_text}",
            "Reason: self-service password reset limit exceeded",
        ]
    )
    return "\n".join(lines)


def _build_contact_admin_html(target: PasswordResetTarget, requested_at: datetime) -> str:
    requested_at_text = escape(requested_at.strftime("%Y-%m-%d %H:%M:%S UTC"))
    rows = [
        ("Tenant/Company", target.tenant.name),
        ("User Name", target.full_name or target.username),
        ("Username", target.username),
        ("Email", target.email),
    ]
    if target.employee_code:
        rows.append(("Employee ID", target.employee_code))
    rows.extend(
        [
            ("Request Time", requested_at_text),
            ("Reason", "self-service password reset limit exceeded"),
        ]
    )
    row_html = "".join(
        f"<tr><td style='padding:6px 10px;font-weight:600'>{escape(label)}</td>"
        f"<td style='padding:6px 10px'>{escape(value)}</td></tr>"
        for label, value in rows
    )
    return f"""
<html>
  <body style="font-family: Arial, sans-serif; color: #111827;">
    <p>A password reset assistance request was submitted.</p>
    <table style="border-collapse: collapse;">{row_html}</table>
  </body>
</html>
""".strip()


def _build_admin_password_changed_text(full_name: str, tenant_name: str, actor_name: str) -> str:
    return (
        f"Hello {full_name or 'User'},\n\n"
        f"Your password for {tenant_name} was updated by {actor_name}.\n"
        "If you did not expect this change, please contact your administrator immediately."
    )


def _build_admin_password_changed_html(full_name: str, tenant_name: str, actor_name: str) -> str:
    return f"""
<html>
  <body style="font-family: Arial, sans-serif; color: #111827;">
    <p>Hello {escape(full_name or 'User')},</p>
    <p>Your password for {escape(tenant_name)} was updated by {escape(actor_name)}.</p>
    <p>If you did not expect this change, please contact your administrator immediately.</p>
  </body>
</html>
""".strip()


def _refresh_reset_window(
    user: User,
    tenant: Tenant,
    now: datetime,
    *,
    initialize_if_missing: bool,
) -> bool:
    current_start = _as_utc(getattr(user, "reset_window_start", None))
    if current_start is None:
        if initialize_if_missing:
            user.reset_window_start = now
            user.reset_count = 0
            return True
        return False

    if now >= current_start + timedelta(days=_tenant_reset_limit_days(tenant)):
        user.reset_count = 0
        user.reset_window_start = now if initialize_if_missing else None
        return True

    return False


def request_password_reset(
    master_db: Session,
    request: Request,
    email: str,
    employee_code: str | None = None,
) -> PasswordResetTarget:
    targets = _find_password_reset_targets(master_db, email, employee_code)
    if not targets:
        raise PasswordResetError("No user found with this email address.")

    if len(targets) > 1:
        raise PasswordResetError(
            "Multiple accounts are associated with this email. Please contact your administrator."
        )

    target = targets[0]
    _ensure_password_reset_allowed(target)

    tenant_db = None
    try:
        tenant_db = get_tenant_session(target.tenant.slug)
        user = tenant_db.query(User).filter(
            User.id == target.user_id,
            func.lower(User.email) == _normalize_email(target.email),
        ).first()
        if not user:
            raise PasswordResetError("No user found with this email address.")
        if not user.is_active:
            raise PasswordResetError("User account is inactive. Please contact your administrator.")

        now = _utcnow()
        window_changed = _refresh_reset_window(
            user,
            target.tenant,
            now,
            initialize_if_missing=False,
        )
        current_reset_count = int(getattr(user, "reset_count", 0) or 0)
        reset_limit = _tenant_reset_limit_count(target.tenant)

        if current_reset_count >= reset_limit:
            if window_changed:
                tenant_db.commit()
            raise PasswordResetError(RESET_LIMIT_EXCEEDED_MESSAGE)

        reset_token = create_password_reset_token(
            user_id=user.id,
            tenant_id=target.tenant.id,
            tenant_slug=target.tenant.slug,
            email=user.email,
            password_fingerprint=password_reset_token_fingerprint(user.hashed_password),
            purpose=PASSWORD_RESET_PURPOSE_FORGOT_PASSWORD,
        )
        reset_url = build_password_reset_url(request, reset_token)
        intro_line = f"We received a password reset request for your {target.tenant.name} account."
        text_body = _build_reset_email_text(user.full_name, target.tenant.name, reset_url, intro_line)
        html_body = _build_reset_email_html(user.full_name, target.tenant.name, reset_url, intro_line)

        try:
            send_tenant_email(
                tenant=target.tenant,
                to_email=user.email,
                subject="Reset your password",
                text_body=text_body,
                html_body=html_body,
            )
        except TenantEmailConfigurationError as exc:
            raise PasswordResetError(str(exc)) from exc
        except TenantEmailDeliveryError as exc:
            raise PasswordResetError(
                "Unable to send reset email at the moment. Please try again later.",
                status_code=500,
            ) from exc

        if window_changed:
            tenant_db.commit()
        return _build_target_from_user(target.tenant, user)
    except PasswordResetError:
        if tenant_db is not None:
            tenant_db.rollback()
        raise
    except Exception as exc:
        if tenant_db is not None:
            tenant_db.rollback()
        logger.exception("Forgot-password flow failed for tenant=%s email=%s", target.tenant.slug, target.email)
        raise PasswordResetError(
            "Unable to process the password reset request at the moment. Please try again later.",
            status_code=500,
        ) from exc
    finally:
        if tenant_db is not None:
            tenant_db.close()


def reset_password_with_token(master_db: Session, token: str, new_password: str) -> PasswordResetResult:
    is_valid, validation_message = validate_password_strength(new_password)
    if not is_valid:
        raise PasswordResetError(validation_message)

    payload = verify_password_reset_token(token)
    if not payload:
        raise PasswordResetError("Invalid or expired reset link.")

    tenant_id = payload.get("tenant_id")
    tenant_slug = payload.get("tenant_slug")
    email = payload.get("email")
    user_id = payload.get("user_id")

    if not tenant_id or not tenant_slug or not email or not user_id:
        raise PasswordResetError("Invalid or expired reset link.")

    tenant = master_db.query(Tenant).filter(
        Tenant.id == int(tenant_id),
        Tenant.slug == str(tenant_slug),
    ).first()
    if not tenant:
        raise PasswordResetError("Invalid or expired reset link.")

    if tenant.status not in ACTIVE_PASSWORD_RESET_TENANT_STATUSES:
        raise PasswordResetError("Company account is inactive. Please contact your administrator.")

    tenant_db = None
    try:
        tenant_db = get_tenant_session(tenant.slug)
        user = tenant_db.query(User).filter(
            User.id == int(user_id),
            func.lower(User.email) == _normalize_email(email),
        ).first()
        if not user:
            raise PasswordResetError("Invalid or expired reset link.")
        if not user.is_active:
            raise PasswordResetError("User account is inactive. Please contact your administrator.")
        if payload.get("pwd") != password_reset_token_fingerprint(user.hashed_password):
            raise PasswordResetError("Invalid or expired reset link.")

        now = _utcnow()
        counts_toward_limit = _password_reset_counts_toward_self_service_limit(payload)
        current_reset_count = int(getattr(user, "reset_count", 0) or 0)

        if counts_toward_limit:
            _refresh_reset_window(
                user,
                tenant,
                now,
                initialize_if_missing=True,
            )
            current_reset_count = int(getattr(user, "reset_count", 0) or 0)
            reset_limit = _tenant_reset_limit_count(tenant)
            if current_reset_count >= reset_limit:
                raise PasswordResetError(RESET_LIMIT_EXCEEDED_MESSAGE)

        user.hashed_password = hash_password(new_password)
        user.last_password_changed_at = now
        user.must_change_password = False
        user.last_self_service_reset_at = now
        if counts_toward_limit:
            user.reset_count = current_reset_count + 1
            if getattr(user, "reset_window_start", None) is None:
                user.reset_window_start = now
        tenant_db.commit()
        return PasswordResetResult(tenant=tenant, user_id=user.id, email=user.email)
    except PasswordResetError:
        if tenant_db is not None:
            tenant_db.rollback()
        raise
    except Exception as exc:
        if tenant_db is not None:
            tenant_db.rollback()
        logger.exception("Password reset failed for tenant=%s user=%s", tenant.slug, user_id)
        raise PasswordResetError(
            "Unable to reset password at the moment. Please try again later.",
            status_code=500,
        ) from exc
    finally:
        if tenant_db is not None:
            tenant_db.close()


def evaluate_password_change_requirement(tenant: Tenant, user: User) -> PasswordChangeRequirementResult:
    now = _utcnow()
    password_expired = False
    must_change_password = bool(getattr(user, "must_change_password", False))

    if getattr(tenant, "force_password_change_on_first_login", False):
        last_login_at = _as_utc(getattr(user, "last_login", None))
        last_password_changed_at = _as_utc(getattr(user, "last_password_changed_at", None))
        created_at = _as_utc(getattr(user, "created_at", None))
        last_reset_at = _as_utc(getattr(user, "last_self_service_reset_at", None))
        has_completed_first_login_reset = bool(
            last_reset_at and last_password_changed_at and last_reset_at >= last_password_changed_at
        )
        if last_login_at is None and not has_completed_first_login_reset:
            if (
                must_change_password
                or
                last_password_changed_at is None
                or created_at is None
                or last_password_changed_at <= created_at + FIRST_LOGIN_PASSWORD_CHANGE_WINDOW
            ):
                must_change_password = True
                user.must_change_password = True

    if getattr(tenant, "password_expiry_enabled", False):
        reference_time = (
            _as_utc(getattr(user, "last_password_changed_at", None))
            or _as_utc(getattr(user, "created_at", None))
        )
        if reference_time and now >= reference_time + timedelta(days=_tenant_password_expiry_days(tenant)):
            password_expired = True
            must_change_password = True
            user.must_change_password = True

    if not must_change_password:
        return PasswordChangeRequirementResult(
            password_expired=False,
            must_change_password=False,
            reset_token=None,
        )

    reset_token = create_password_reset_token(
        user_id=user.id,
        tenant_id=tenant.id,
        tenant_slug=tenant.slug,
        email=user.email,
        password_fingerprint=password_reset_token_fingerprint(user.hashed_password),
        purpose=PASSWORD_RESET_PURPOSE_PASSWORD_EXPIRED,
    )
    return PasswordChangeRequirementResult(
        password_expired=password_expired,
        must_change_password=True,
        reset_token=reset_token,
    )


def send_contact_administrator_request(
    master_db: Session,
    request: Request,
    *,
    email: str | None = None,
    tenant_slug: str | None = None,
    username: str | None = None,
) -> PasswordResetTarget:
    target = _find_contact_administrator_target(
        master_db,
        email=email,
        tenant_slug=tenant_slug,
        username=username,
    )
    requested_at = _utcnow()
    text_body = _build_contact_admin_text(target, requested_at)
    html_body = _build_contact_admin_html(target, requested_at)

    try:
        send_tenant_email(
            tenant=target.tenant,
            to_email=target.tenant.admin_email,
            subject="Password reset assistance request",
            text_body=text_body,
            html_body=html_body,
        )
    except TenantEmailConfigurationError as exc:
        raise PasswordResetError(
            "Unable to send administrator request at the moment. Please contact your administrator directly."
        ) from exc
    except TenantEmailDeliveryError as exc:
        raise PasswordResetError(
            "Unable to send administrator request at the moment. Please contact your administrator directly.",
            status_code=500,
        ) from exc

    return target


def send_admin_password_reset_link(
    master_db: Session,
    request: Request,
    *,
    tenant_slug: str,
    user_id: int,
) -> PasswordResetTarget:
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise PasswordResetError("Tenant not found.", status_code=404)
    if tenant.status not in ACTIVE_PASSWORD_RESET_TENANT_STATUSES:
        raise PasswordResetError("Company account is inactive. Please contact your administrator.")

    tenant_db = None
    try:
        tenant_db = get_tenant_session(tenant.slug)
        user = tenant_db.query(User).filter(User.id == user_id).first()
        if not user:
            raise PasswordResetError("User not found.", status_code=404)
        if not user.is_active:
            raise PasswordResetError("User account is inactive. Please contact your administrator.")

        reset_token = create_password_reset_token(
            user_id=user.id,
            tenant_id=tenant.id,
            tenant_slug=tenant.slug,
            email=user.email,
            password_fingerprint=password_reset_token_fingerprint(user.hashed_password),
            purpose=PASSWORD_RESET_PURPOSE_ADMIN,
        )
        reset_url = build_password_reset_url(request, reset_token)
        intro_line = f"An administrator requested a password reset for your {tenant.name} account."
        text_body = _build_reset_email_text(user.full_name, tenant.name, reset_url, intro_line)
        html_body = _build_reset_email_html(user.full_name, tenant.name, reset_url, intro_line)
        send_tenant_email(
            tenant=tenant,
            to_email=user.email,
            subject="Complete your password reset",
            text_body=text_body,
            html_body=html_body,
        )
        return _build_target_from_user(tenant, user)
    except PasswordResetError:
        raise
    except TenantEmailConfigurationError as exc:
        raise PasswordResetError(str(exc)) from exc
    except TenantEmailDeliveryError as exc:
        raise PasswordResetError(
            "Unable to send reset email at the moment. Please try again later.",
            status_code=500,
        ) from exc
    finally:
        if tenant_db is not None:
            tenant_db.close()


def send_admin_password_changed_notification(
    master_db: Session,
    *,
    tenant_slug: str,
    user_id: int,
    actor_name: str,
) -> None:
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        return

    tenant_db = None
    try:
        tenant_db = get_tenant_session(tenant.slug)
        user = tenant_db.query(User).filter(User.id == user_id).first()
        if not user or not user.email:
            return

        text_body = _build_admin_password_changed_text(user.full_name, tenant.name, actor_name)
        html_body = _build_admin_password_changed_html(user.full_name, tenant.name, actor_name)
        send_tenant_email(
            tenant=tenant,
            to_email=user.email,
            subject="Your password was updated",
            text_body=text_body,
            html_body=html_body,
        )
    except (TenantEmailConfigurationError, TenantEmailDeliveryError) as exc:
        logger.warning(
            "Admin password change notification failed for tenant=%s user=%s: %s",
            tenant_slug,
            user_id,
            exc,
        )
    except Exception as exc:
        logger.warning(
            "Unexpected admin password change notification failure for tenant=%s user=%s: %s",
            tenant_slug,
            user_id,
            exc,
        )
    finally:
        if tenant_db is not None:
            tenant_db.close()

