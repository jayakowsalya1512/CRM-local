"""
FastAPI dependency injectors: tenant DB session, current user, role guards.
"""
import logging
from datetime import datetime, timedelta, timezone

from typing import Optional, Generator
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import text
from sqlalchemy.orm import Session
from app.database import MasterSessionLocal, get_master_db, get_tenant_session_by_db_name, normalize_tenant_slug
from app.models.tenant import Tenant, SuperAdmin, PlatformSession, PlatformSessionPolicy
from app.models.user import User, UserSession
from app.core.security import verify_token
from app.core.timezone import IST, as_utc_from_ist, now_ist
from app.services.auth_policy_service import get_remember_me_expiry_minutes

logger = logging.getLogger(__name__)
security = HTTPBearer(auto_error=False)
_tenant_lead_conversion_schema_checked: set[str] = set()
_tenant_kam_activity_schema_checked: set[str] = set()
_tenant_kam_activity_reopen_schema_checked: set[str] = set()


def _istnow_naive():
    return now_ist()

def touch_user_session_activity(db, session_row):
    session_row.last_active = _istnow_naive()

# ─── Master DB ────────────────────────────────────────────────────────────────

def get_master_db_dep() -> Generator:
    db = MasterSessionLocal()
    try:
        yield db
    finally:
        db.close()


# ─── Helpers ──────────────────────────────────────────────────────────────────

def get_request_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _resolve_tenant_slug(request: Request) -> str:
    """Extract tenant slug from request state, header, or query param."""
    slug = (
        getattr(request.state, "tenant_slug", None)
        or request.headers.get("x-tenant-slug", "").strip()
        or request.query_params.get("tenant", "").strip()
        or None
    )
    if not slug:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tenant not identified. Provide X-Tenant-Slug header or use subdomain.",
        )
    try:
        return normalize_tenant_slug(slug)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc


def _get_registered_tenant(master_db: Session, tenant_slug: str) -> Tenant:
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tenant '{tenant_slug}' not found.",
        )
    return tenant


def _ensure_lead_conversion_target_column(db: Session, tenant: Tenant) -> None:
    """Hotfix tenant DBs that have the updated Lead model before the migration ran."""
    key = (tenant.db_name or tenant.slug or "").strip().lower()
    if not key or key in _tenant_lead_conversion_schema_checked:
        return

    try:
        db.execute(text(
            "ALTER TABLE leads "
            "ADD COLUMN IF NOT EXISTS conversion_target VARCHAR(30) NULL "
            "COMMENT 'Chosen conversion path: tender or quotation'"
        ))
        db.commit()
        _tenant_lead_conversion_schema_checked.add(key)
    except Exception as exc:
        db.rollback()
        logger.warning(
            "Tenant lead conversion_target schema sync failed for %s: %s",
            tenant.slug,
            exc,
        )


def _ensure_kam_activity_schema_columns(db: Session, tenant: Tenant) -> None:
    """
    Hotfix tenant DBs that have the updated KAMActivity model (record linkage +
    geolocation columns) before a migration ran. Runs once per tenant per
    process lifetime — kam_activities is queried by many routers (kam, customer,
    dashboard, lead, reports, travel, ...), so this has to run centrally here
    rather than being sprinkled across each router that happens to touch it.
    """
    key = (tenant.db_name or tenant.slug or "").strip().lower()
    if not key or key in _tenant_kam_activity_schema_checked:
        return

    try:
        db.execute(text(
            "ALTER TABLE kam_activities "
            "ADD COLUMN IF NOT EXISTS tender_id INT NULL, "
            "ADD COLUMN IF NOT EXISTS work_order_id INT NULL, "
            "ADD COLUMN IF NOT EXISTS emdbg_id INT NULL, "
            "ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,7) NULL, "
            "ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7) NULL, "
            "ADD COLUMN IF NOT EXISTS document_url VARCHAR(500) NULL, "
            "ADD COLUMN IF NOT EXISTS document_name VARCHAR(300) NULL, "
            "ADD COLUMN IF NOT EXISTS document_size_kb INT NULL"
        ))
        db.commit()
        _tenant_kam_activity_schema_checked.add(key)
    except Exception as exc:
        db.rollback()
        logger.warning(
            "Tenant kam_activities schema sync failed for %s: %s",
            tenant.slug,
            exc,
        )


def _ensure_kam_activity_reopen_schema(db: Session, tenant: Tenant) -> None:
    """
    Hotfix tenant DBs for the KAM activity audit/GPS-history/manager-reopen
    workflow: adds the reopen-tracking columns to kam_activities, the
    'Reopened' status value, and creates the combined kam_log table (events +
    GPS in one row) and the execution-cycle table. Runs once per tenant per process lifetime — same
    pattern as _ensure_kam_activity_schema_columns above. The one-time
    per-tenant backfill of existing rows into cycle 1 is handled separately
    by migrate_kam_activity_reopen.py, not here (this hotfix only guarantees
    the columns/tables exist so requests don't fail; it does not backfill).
    """
    key = (tenant.db_name or tenant.slug or "").strip().lower()
    if not key or key in _tenant_kam_activity_reopen_schema_checked:
        return

    try:
        # MySQL 8.0.12+ treats appending a new value to the end of an ENUM as an
        # instant, metadata-only change (no table rebuild/lock) — safe to run here.
        db.execute(text(
            "ALTER TABLE kam_activities "
            "MODIFY COLUMN status ENUM('Planned','In Progress','Completed','Cancelled','Postponed','Reopened') NULL"
        ))
        db.execute(text(
            "ALTER TABLE kam_activities "
            "ADD COLUMN IF NOT EXISTS current_cycle_no INT NOT NULL DEFAULT 1, "
            "ADD COLUMN IF NOT EXISTS reopen_count INT NOT NULL DEFAULT 0, "
            "ADD COLUMN IF NOT EXISTS last_reopened_at DATETIME NULL, "
            "ADD COLUMN IF NOT EXISTS last_reopened_by INT NULL"
        ))
        db.execute(text("""
            CREATE TABLE IF NOT EXISTS kam_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                activity_id INT NOT NULL,
                cycle_no INT NOT NULL DEFAULT 1,
                event_type VARCHAR(60) NOT NULL,
                previous_status VARCHAR(30) NULL,
                new_status VARCHAR(30) NULL,
                actor_user_id INT NULL,
                actor_role VARCHAR(50) NULL,
                reason VARCHAR(500) NULL,
                remarks TEXT NULL,
                old_values_json JSON NULL,
                new_values_json JSON NULL,
                metadata_json JSON NULL,
                latitude DECIMAL(10,7) NULL,
                longitude DECIMAL(10,7) NULL,
                accuracy_meters DECIMAL(10,2) NULL,
                address VARCHAR(500) NULL,
                locality VARCHAR(150) NULL,
                district VARCHAR(150) NULL,
                state VARCHAR(150) NULL,
                postal_code VARCHAR(20) NULL,
                permission_status VARCHAR(30) NULL,
                is_mock_location TINYINT(1) NOT NULL DEFAULT 0,
                capture_source VARCHAR(30) NULL,
                client_event_at DATETIME NULL,
                event_at DATETIME NOT NULL,
                source VARCHAR(30) NULL,
                device_id VARCHAR(255) NULL,
                ip_address VARCHAR(45) NULL,
                request_id VARCHAR(100) NULL,
                idempotency_key VARCHAR(100) NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_kam_log_activity_idem (activity_id, idempotency_key),
                KEY ix_kam_log_activity_time (activity_id, event_at),
                KEY ix_kam_log_actor_time (actor_user_id, event_at),
                KEY ix_kam_log_event_type (event_type),
                KEY ix_kam_log_activity_cycle (activity_id, cycle_no),
                KEY ix_kam_log_activity_location (activity_id, latitude, longitude),
                CONSTRAINT fk_kam_log_activity FOREIGN KEY (activity_id) REFERENCES kam_activities(id) ON DELETE RESTRICT,
                CONSTRAINT fk_kam_log_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """))
        db.execute(text("""
            CREATE TABLE IF NOT EXISTS kam_activity_execution_cycles (
                id INT AUTO_INCREMENT PRIMARY KEY,
                activity_id INT NOT NULL,
                cycle_no INT NOT NULL,
                status VARCHAR(30) NOT NULL DEFAULT 'Open',
                opened_at DATETIME NOT NULL,
                opened_by INT NULL,
                open_reason TEXT NULL,
                started_at DATETIME NULL,
                started_by INT NULL,
                completed_at DATETIME NULL,
                completed_by INT NULL,
                completion_notes TEXT NULL,
                completion_outcome TEXT NULL,
                actual_duration_minutes INT NULL,
                reopened_at DATETIME NULL,
                reopened_by INT NULL,
                reopen_reason TEXT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_kam_activity_cycle_no (activity_id, cycle_no),
                KEY ix_kam_activity_cycle_status (activity_id, status),
                CONSTRAINT fk_kam_cycle_activity FOREIGN KEY (activity_id) REFERENCES kam_activities(id) ON DELETE RESTRICT,
                CONSTRAINT fk_kam_cycle_opened_by FOREIGN KEY (opened_by) REFERENCES users(id) ON DELETE SET NULL,
                CONSTRAINT fk_kam_cycle_started_by FOREIGN KEY (started_by) REFERENCES users(id) ON DELETE SET NULL,
                CONSTRAINT fk_kam_cycle_completed_by FOREIGN KEY (completed_by) REFERENCES users(id) ON DELETE SET NULL,
                CONSTRAINT fk_kam_cycle_reopened_by FOREIGN KEY (reopened_by) REFERENCES users(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """))
        db.commit()
        _tenant_kam_activity_reopen_schema_checked.add(key)
    except Exception as exc:
        db.rollback()
        logger.warning(
            "Tenant kam_activities reopen-workflow schema sync failed for %s: %s",
            tenant.slug,
            exc,
        )


def _as_utc(value: Optional[datetime]) -> Optional[datetime]:
    return as_utc_from_ist(value)


def _parse_token_datetime(value) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return _as_utc(value)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc)
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            return datetime.fromtimestamp(float(raw), tz=timezone.utc)
        except ValueError:
            try:
                return _as_utc(datetime.fromisoformat(raw))
            except ValueError:
                return None
    return None


def _build_revoked_session_detail(session_row: Optional[UserSession]) -> str:
    revoke_scope = (getattr(session_row, "revoke_scope", None) or "").strip().lower()
    revoke_reason = (getattr(session_row, "revoke_reason", None) or "").strip()

    if revoke_scope == "inactivity":
        return "Your session expired due to inactivity. Please sign in again."

    if revoke_scope == "self":
        return "You were logged out from another device. Please sign in again."

    if revoke_scope in {"selected", "tenant"}:
        return "An administrator logged you out for security reasons. Please sign in again."

    if revoke_reason:
        lowered_reason = revoke_reason.lower()
        if "logged out all other devices" in lowered_reason or "other device" in lowered_reason:
            return "You were logged out from another device. Please sign in again."
        if "forced logout" in lowered_reason or "administrator" in lowered_reason or "admin" in lowered_reason:
            return "An administrator logged you out for security reasons. Please sign in again."

    return "Session expired. Please sign in again."


def _build_inactive_session_detail() -> str:
    return "Your session expired due to inactivity. Please sign in again."


def _as_session_timestamp(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=IST).astimezone(timezone.utc)
    return value.astimezone(timezone.utc)

def ensure_session_within_activity_window(
    db: Session,
    tenant: Tenant,
    session_row: Optional[UserSession],
) -> None:
    if session_row is None:
        return

    session_window_minutes = get_remember_me_expiry_minutes(tenant)
    last_active = _as_session_timestamp(getattr(session_row, "last_active", None)) or _as_session_timestamp(getattr(session_row, "login_time", None))
    if last_active is None:
        return

    now_utc = datetime.now(timezone.utc)
    now_ist = _istnow_naive()

    if (now_utc - last_active).total_seconds() <= session_window_minutes * 60:
        return

    session_row.is_active = False
    session_row.revoked_at = now_ist
    session_row.logout_time = now_ist

    session_row.revoke_scope = "inactivity"
    session_row.revoke_reason = "Session expired due to inactivity"
    db.flush()
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=_build_inactive_session_detail(),
        headers={"WWW-Authenticate": "Bearer"},
    )


# def touch_user_session_activity(
#     db: Session,
#     session_row: Optional[UserSession],
#     *,
#     touched_at: Optional[datetime] = None,
# ) -> None:
#     if session_row is None:
#         return
#     session_row.last_active = touched_at or datetime.now(timezone.utc)
#     db.flush()


def ensure_token_session_is_active(
    payload: dict,
    tenant: Tenant,
    user: User,
    db: Session,
) -> Optional[UserSession]:
    issued_at = _parse_token_datetime(payload.get("iat"))
    if issued_at is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    tenant_force_logout_after = _as_utc(getattr(tenant, "force_logout_after", None))
    if tenant_force_logout_after and issued_at <= tenant_force_logout_after:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="An administrator logged you out for security reasons. Please sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_force_logout_after = _as_utc(getattr(user, "force_logout_after", None))
    if user_force_logout_after and issued_at <= user_force_logout_after:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="An administrator logged you out for security reasons. Please sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    session_jti = str(payload.get("session_jti") or "").strip()
    if not session_jti:
        return

    session_row = db.query(UserSession).filter(
        UserSession.user_id == user.id,
        UserSession.session_jti == session_jti,
    ).first()
    if not session_row or not bool(session_row.is_active) or getattr(session_row, "revoked_at", None):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_build_revoked_session_detail(session_row),
            headers={"WWW-Authenticate": "Bearer"},
        )
    ensure_session_within_activity_window(db, tenant, session_row)
    return session_row


# ─── Tenant DB ────────────────────────────────────────────────────────────────
# FIX 1: Use `yield` so FastAPI closes the session after every request,
#         even on exceptions. Previously used `return` — session was NEVER closed.

def get_tenant_db(request: Request) -> Generator:
    tenant_slug = _resolve_tenant_slug(request)
    # print(f">>> get_tenant_db: tenant_slug={tenant_slug}")  # keep your debug log

    master_db = MasterSessionLocal()
    try:
        tenant = _get_registered_tenant(master_db, tenant_slug)
    finally:
        master_db.close()

    try:
        session = get_tenant_session_by_db_name(tenant.db_name, cache_key=tenant.slug)
    except Exception as e:
        logger.error(f"Failed to connect to tenant DB '{tenant_slug}': {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Tenant database unavailable: {str(e)}",
        )
    _ensure_lead_conversion_target_column(session, tenant)
    _ensure_kam_activity_schema_columns(session, tenant)
    _ensure_kam_activity_reopen_schema(session, tenant)

    request.state.tenant_slug = tenant.slug
    request.state.tenant = tenant
    request.state.tenant_db = session
    session.info["tenant_slug"] = tenant.slug
    try:
        yield session          # ← FastAPI calls everything after yield on teardown
    except Exception:
        session.rollback()     # roll back on unhandled errors
        raise
    finally:
        session.close()        # ALWAYS release connection back to pool


# ─── Current user ─────────────────────────────────────────────────────────────
# FIX 2: Inject `db` via Depends(get_tenant_db) instead of calling get_tenant_db()
#         directly. Direct call created a SECOND session that was never closed.

def _api_key_user(request: Request, raw_key: str, db: Session, master_db: Session) -> User:
    """Tenant API key (Platform admin → API & webhooks): signs in as the key's user, only for the key's own tenant,
    rate-limited by the tenant's plan."""
    from app.services import platform_api_keys
    unauthorized = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key", headers={"WWW-Authenticate": "Bearer"})
    key = platform_api_keys.verify(master_db, raw_key)
    if key is None:
        raise unauthorized
    tenant_slug = getattr(request.state, "tenant_slug", None) or _resolve_tenant_slug(request)
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if tenant is None or tenant.id != key.tenant_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API key does not belong to the requested tenant")
    if not platform_api_keys.allows(key, request.method):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This API key is read-only (scope: read)")
    if platform_api_keys.limiting_enabled(master_db):
        per_minute, burst, daily_cap = platform_api_keys.tenant_limit(master_db, tenant)
        allowed, wait, reason, _left = platform_api_keys.take(tenant.id, per_minute, burst, daily_cap)
        if not allowed:
            platform_api_keys.record_limited(tenant.slug)
            detail = f"Daily API cap reached ({daily_cap:,} requests per day) – resets at midnight IST" if reason == "daily" \
                else f"Rate limit exceeded ({per_minute} requests/min, burst {burst})"
            headers = {"Retry-After": str(wait), "X-RateLimit-Limit": str(per_minute)}
            if daily_cap:
                headers["X-RateLimit-Daily-Limit"] = str(daily_cap)
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=detail, headers=headers)
    user = db.query(User).filter(User.id == key.user_id, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="The API key's user is inactive")
    from app.services.platform_trust_safety import blocked_sign_in
    if blocked_sign_in(master_db, tenant.id, user.id, user.email, None):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This account has been disabled. Contact your administrator.")
    platform_api_keys.touch(master_db, key)
    request.state.current_access_payload = {"sub": str(user.id), "tenant_id": tenant.id, "api_key_id": key.id}
    request.state.current_session = None
    request.state.current_user = user
    request.state.api_key_id = key.id
    return user


def get_current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: Session = Depends(get_tenant_db),   # ← reuses the SAME session as the router
    master_db: Session = Depends(get_master_db_dep),
) -> User:
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if credentials.credentials.startswith("azx_"):
        return _api_key_user(request, credentials.credentials, db, master_db)

    payload = verify_token(credentials.credentials, "access")
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    tenant_slug = getattr(request.state, "tenant_slug", None) or _resolve_tenant_slug(request)
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()

    try:
        token_tenant_id = int(payload["tenant_id"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid tenant token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    if not tenant or token_tenant_id != tenant.id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token does not match the requested tenant",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = int(payload["sub"])
    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
        )

    session_row = ensure_token_session_is_active(payload, tenant, user, db)
    request.state.current_access_payload = payload
    request.state.current_session = session_row
    request.state.current_user = user
    return user


# ─── Platform current admin ───────────────────────────────────────────────────

def get_current_platform_admin(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: Session = Depends(get_master_db_dep),
) -> SuperAdmin:
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Platform authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = verify_token(credentials.credentials, "access")
    if not payload or payload.get("tenant_id") is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired platform token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        admin_id = int(payload["sub"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid platform token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    admin = db.query(SuperAdmin).filter(
        SuperAdmin.id == admin_id,
        SuperAdmin.is_active == True,
    ).first()

    if not admin:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Platform administrator not found or inactive",
            headers={"WWW-Authenticate": "Bearer"},
        )

    session_id = payload.get("session_jti")
    if not session_id:
        raise HTTPException(status_code=401, detail="Please sign in again", headers={"WWW-Authenticate": "Bearer"})
    platform_session = db.query(PlatformSession).filter(PlatformSession.id == session_id, PlatformSession.admin_id == admin.id).first()
    policy = db.query(PlatformSessionPolicy).filter(PlatformSessionPolicy.id == 1).first()
    timeout = policy.timeout_minutes if policy else 30
    if not platform_session or not platform_session.is_active or platform_session.last_active + timedelta(minutes=timeout) <= datetime.utcnow():
        if platform_session and platform_session.is_active:
            platform_session.is_active = False
            db.commit()
        raise HTTPException(status_code=401, detail="Platform session expired", headers={"WWW-Authenticate": "Bearer"})
    request.state.platform_session = platform_session
    request.state.platform_admin = admin
    return admin


# ─── Role guards ──────────────────────────────────────────────────────────────

def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in ("admin", "ceo"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return current_user


def require_manager_or_above(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in ("admin", "ceo", "manager"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Manager or admin access required")
    return current_user


def require_sales_or_above(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in ("admin", "ceo", "manager", "sales"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sales role or above required")
    return current_user


def require_platform_super_admin(
    current_admin: SuperAdmin = Depends(get_current_platform_admin),
) -> SuperAdmin:
    return current_admin


def ensure_permission(db: Session, current_user: User, permission_key: str) -> None:
    """
    Raise 403 unless the user's role holds *permission_key* in the RolePermission
    table. Respects whatever the admin configured, including when a permission
    is revoked for Admin or any other role.
    """
    from app.models.all_models import Module, Role, Permission, RolePermission
    from app.services.tenant_module_service import DEFAULT_TENANT_MODULE_KEYS

    role_row = db.query(Role).filter(
        Role.name == current_user.role,
        Role.is_active == True,
    ).first()
    if not role_row:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Role '{current_user.role}' not found or inactive",
        )

    perm = db.query(Permission).filter(Permission.key == permission_key).first()
    if not perm:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Permission '{permission_key}' is not configured in the system",
        )

    module_key = (perm.module or "").strip().lower()
    if module_key:
        module = db.query(Module).filter(Module.key == module_key).first()
        if (module_key in DEFAULT_TENANT_MODULE_KEYS and not module) or (module and not bool(module.is_active)):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This module is not enabled for your tenant",
            )

    rp = db.query(RolePermission).filter(
        RolePermission.role_id == role_row.id,
        RolePermission.permission_id == perm.id,
    ).first()
    if not rp:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to perform this action",
        )


def user_has_permission(db: Session, current_user: User, permission_key: str) -> bool:
    try:
        ensure_permission(db, current_user, permission_key)
    except HTTPException:
        return False
    return True


def require_permission(permission_key: str):
    """
    Factory that returns a FastAPI dependency enforcing a specific permission key.
    See ensure_permission for the rules applied.
    """
    def _dep(
        db: Session = Depends(get_tenant_db),
        current_user: User = Depends(get_current_user),
    ) -> User:
        ensure_permission(db, current_user, permission_key)
        return current_user

    return _dep
