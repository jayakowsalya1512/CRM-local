"""
Security utilities: password hashing, JWT tokens, CAPTCHA token validation.
"""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _bcrypt_safe_password(password: str) -> str:
    """
    bcrypt accepts maximum 72 bytes.

    Important:
    - bcrypt limit is 72 bytes, not 72 characters.
    - Do not silently truncate passwords using password[:72].
    - If password is longer than 72 bytes, return invalid login instead of crashing.
    """
    if password is None:
        return ""

    password = str(password)

    if len(password.encode("utf-8")) > 72:
        raise ValueError("Password cannot be longer than 72 bytes")

    return password


def hash_password(password: str) -> str:
    """
    Hash plain password using bcrypt.
    """
    password = _bcrypt_safe_password(password)
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    """
    Verify plain password against stored bcrypt hash.

    This function must never raise bcrypt 72-byte errors to the API layer.
    It should return False for invalid/too-long passwords.
    """
    if not plain or not hashed:
        return False

    try:
        plain = _bcrypt_safe_password(plain)
        return pwd_context.verify(plain, hashed)
    except ValueError:
        return False
    except Exception:
        return False


def validate_password_strength(password: str) -> tuple[bool, str]:
    if not password:
        return False, "Password is required"

    if len(password.encode("utf-8")) > 72:
        return False, "Password cannot be longer than 72 bytes"

    if len(password) < settings.PASSWORD_MIN_LENGTH:
        return False, f"Password must be at least {settings.PASSWORD_MIN_LENGTH} characters"

    if not any(c.isupper() for c in password):
        return False, "Password must contain at least one uppercase letter"

    if not any(c.islower() for c in password):
        return False, "Password must contain at least one lowercase letter"

    if not any(c.isdigit() for c in password):
        return False, "Password must contain at least one digit"

    if not any((not c.isalnum()) and (not c.isspace()) for c in password):
        return False, "Password must contain at least one special character"

    return True, "OK"


def password_reset_token_fingerprint(hashed_password: str) -> str:
    payload = f"{settings.SECRET_KEY}:{hashed_password}"
    return hashlib.sha256(payload.encode()).hexdigest()


TRUSTED_DEVICE_EXPIRE_DAYS = 30


def hash_device_uuid(device_uuid: str) -> str:
    return hashlib.sha256(f"{settings.SECRET_KEY}:{device_uuid}".encode()).hexdigest()


def create_trusted_device_token(td_id: int, user_id: int, tenant_slug: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "td_id": td_id,
        "user_id": user_id,
        "tenant_slug": tenant_slug,
        "type": "trusted_device",
        "iat": now,
        "exp": now + timedelta(days=TRUSTED_DEVICE_EXPIRE_DAYS),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def verify_trusted_device_token(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        if payload.get("type") != "trusted_device":
            return None
        return payload
    except Exception:
        return None


def _resolve_expiry(
    expires_delta: Optional[timedelta],
    default_delta: timedelta,
) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    return now, now + (expires_delta if expires_delta is not None else default_delta)


def create_access_token(
    user_id: int,
    tenant_id: Optional[int] = None,
    expires_delta: Optional[timedelta] = None,
    session_jti: Optional[str] = None,
) -> str:
    issued_at, expire = _resolve_expiry(
        expires_delta,
        timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
    )

    payload = {
        "sub": str(user_id),
        "user_id": user_id,
        "exp": expire,
        "type": "access",
        "tenant_id": tenant_id,
        "iat": issued_at,
    }

    if session_jti:
        payload["session_jti"] = session_jti

    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(
    user_id: int,
    tenant_id: Optional[int] = None,
    expires_delta: Optional[timedelta] = None,
    session_jti: Optional[str] = None,
) -> str:
    issued_at, expire = _resolve_expiry(
        expires_delta,
        timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
    )

    payload = {
        "sub": str(user_id),
        "user_id": user_id,
        "exp": expire,
        "type": "refresh",
        "tenant_id": tenant_id,
        "iat": issued_at,
        "jti": secrets.token_hex(16),
    }

    if session_jti:
        payload["session_jti"] = session_jti

    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_password_reset_token(
    user_id: int,
    tenant_id: int,
    tenant_slug: str,
    email: str,
    password_fingerprint: str,
    purpose: str = "forgot_password",
    expires_delta: Optional[timedelta] = None,
) -> str:
    issued_at, expire = _resolve_expiry(
        expires_delta,
        timedelta(minutes=settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES),
    )

    normalized_purpose = (purpose or "forgot_password").strip().lower() or "forgot_password"

    payload = {
        "sub": str(user_id),
        "user_id": user_id,
        "tenant_id": tenant_id,
        "tenant_slug": tenant_slug,
        "email": email,
        "exp": expire,
        "type": "password_reset",
        "purpose": normalized_purpose,
        "iat": issued_at,
        "jti": secrets.token_hex(16),
        "pwd": password_fingerprint,
    }

    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_quick_pin_setup_token(
    user_id: int,
    tenant_id: int,
    tenant_slug: str,
    expires_delta: Optional[timedelta] = None,
) -> str:
    issued_at, expire = _resolve_expiry(
        expires_delta,
        timedelta(minutes=10),
    )
    payload = {
        "sub": str(user_id),
        "user_id": user_id,
        "tenant_id": tenant_id,
        "tenant_slug": tenant_slug,
        "exp": expire,
        "type": "quick_pin_setup",
        "iat": issued_at,
        "jti": secrets.token_hex(16),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def verify_token(token: str, token_type: str = "access") -> Optional[dict]:
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
        )

        if payload.get("type") != token_type:
            return None

        return payload

    except (JWTError, TypeError, ValueError):
        return None


def verify_password_reset_token(token: str) -> Optional[dict]:
    return verify_token(token, "password_reset")


def verify_quick_pin_setup_token(token: str) -> Optional[dict]:
    return verify_token(token, "quick_pin_setup")


def generate_captcha_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
