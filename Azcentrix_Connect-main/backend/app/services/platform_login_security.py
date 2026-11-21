"""
Platform Administrator login hardening: CAPTCHA, email OTP and retry limits.

Platform-only — the tenant/application login does not use this module.

Everything is enforced server-side and stored in the master DB (not Redis), so
the checks still hold when Redis is unavailable:

* CAPTCHA  — server-generated image; the answer is stored only as an HMAC,
             expires after CAPTCHA_TTL_SECONDS and is single-use (a wrong guess
             burns it).
* Login challenge — created after a correct password when OTP and/or a forced
             password change is still pending. No PlatformSession / JWT exists
             until every pending step is satisfied and the challenge is consumed.
* OTP      — 6-digit code emailed to the administrator, stored as an HMAC, with
             expiry, a wrong-code limit, a resend limit and a resend cooldown.
* Retry limits — failed passwords / CAPTCHAs / OTPs are counted per username
             and per IP, with a temporary lockout. The per-username limit and the
             lockout length are Control Center → Authentication policy
             (``lockout`` / ``lockMin``, defaulting to the config values).
* Trusted devices — a device is remembered for TRUST_DAYS: after an OTP sign-in only when "Trust this device for
             30 days" was ticked, after a sign-in that needed no OTP always (as before, now expiring). A remembered
             device skips "new device" OTP / CAPTCHA and the new-device alert; the 30 days restart on each sign-in.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import secrets
import smtplib
import ssl
from datetime import datetime, timedelta
from email.message import EmailMessage
from typing import Optional

from sqlalchemy import Boolean, Column, DateTime, Integer, String
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database import Base

logger = logging.getLogger(__name__)

OTP_MODES = ("never", "new_device", "every_login")
CAPTCHA_MODES = ("never", "after_failed", "new_device", "every_login")

CAPTCHA_TTL_SECONDS = 300
CAPTCHA_LENGTH = 5
CAPTCHA_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I
LOGIN_CHALLENGE_TTL_MINUTES = 10

IP_MAX_FAILURES = 20
CAPTCHA_AFTER_FAILURES = max(1, int(settings.CAPTCHA_AFTER_ATTEMPTS or 3))


# ─── Tables (platform-only, created on first use) ─────────────────────────────

class PlatformLoginSecurity(Base):
    """Single-row OTP / CAPTCHA policy for Platform Administrator login."""
    __tablename__ = "platform_login_security"
    id = Column(Integer, primary_key=True)
    otp_mode = Column(String(20), nullable=False, default="never")
    captcha_mode = Column(String(20), nullable=False, default="never")
    otp_expiry_minutes = Column(Integer, nullable=False, default=5)
    otp_max_attempts = Column(Integer, nullable=False, default=5)
    otp_max_resends = Column(Integer, nullable=False, default=3)
    otp_resend_cooldown_seconds = Column(Integer, nullable=False, default=30)
    updated_at = Column(DateTime, nullable=True)


class PlatformLoginChallenge(Base):
    __tablename__ = "platform_login_challenges"
    id = Column(String(64), primary_key=True)
    kind = Column(String(16), nullable=False, index=True)  # "captcha" | "login"
    admin_id = Column(Integer, nullable=True, index=True)
    answer_hash = Column(String(128), nullable=True)
    device_hash = Column(String(64), nullable=True)
    ip_address = Column(String(64), nullable=True)
    otp_required = Column(Boolean, nullable=False, default=False)
    otp_verified = Column(Boolean, nullable=False, default=False)
    password_change_required = Column(Boolean, nullable=False, default=False)
    attempts = Column(Integer, nullable=False, default=0)
    resend_count = Column(Integer, nullable=False, default=0)
    last_sent_at = Column(DateTime, nullable=True)
    otp_expires_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=False, index=True)
    consumed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False)


class PlatformTrustedDevice(Base):
    """A device a platform administrator trusts until ``trusted_until`` (device ids are stored hashed)."""
    __tablename__ = "platform_trusted_devices"
    admin_id = Column(Integer, primary_key=True)
    device_hash = Column(String(64), primary_key=True)
    trusted_until = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, nullable=False)
    last_used_at = Column(DateTime, nullable=True)


class PlatformLoginFailure(Base):
    __tablename__ = "platform_login_failures"
    key = Column(String(190), primary_key=True)  # "user:<username>" | "ip:<address>"
    failures = Column(Integer, nullable=False, default=0)
    first_failed_at = Column(DateTime, nullable=False)
    locked_until = Column(DateTime, nullable=True)


_TABLES = (PlatformLoginSecurity, PlatformLoginChallenge, PlatformLoginFailure, PlatformTrustedDevice)
TRUST_DAYS = 30
_tables_ready = False


def ensure_tables(db: Session) -> None:
    global _tables_ready
    if _tables_ready:
        return
    bind = db.get_bind()
    for model in _TABLES:
        model.__table__.create(bind=bind, checkfirst=True)
    _tables_ready = True


def device_trusted(db: Session, admin_id: int, device_hash: Optional[str]) -> bool:
    if not device_hash:
        return False
    ensure_tables(db)
    row = db.get(PlatformTrustedDevice, (admin_id, device_hash))
    return row is not None and row.trusted_until > _now()


def trust_device(db: Session, admin_id: int, device_hash: str) -> PlatformTrustedDevice:
    """Trust (or re-trust) a device for TRUST_DAYS from now."""
    ensure_tables(db)
    now = _now()
    row = db.get(PlatformTrustedDevice, (admin_id, device_hash))
    if row is None:
        row = PlatformTrustedDevice(admin_id=admin_id, device_hash=device_hash, created_at=now)
        db.add(row)
    row.trusted_until, row.last_used_at = now + timedelta(days=TRUST_DAYS), now
    return row


def forget_device(db: Session, admin_id: int, device_hash: str) -> None:
    ensure_tables(db)
    db.query(PlatformTrustedDevice).filter(PlatformTrustedDevice.admin_id == admin_id, PlatformTrustedDevice.device_hash == device_hash).delete()


class LoginSecurityError(Exception):
    """Raised for an expected verification failure; the router maps it to HTTP."""

    def __init__(self, status_code: int, code: str, message: str, **extra):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.extra = extra

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message, **self.extra}


def _now() -> datetime:
    return datetime.utcnow()


def _digest(purpose: str, challenge_id: str, value: str) -> str:
    msg = f"{purpose}:{challenge_id}:{value}".encode()
    return hmac.new(settings.SECRET_KEY.encode(), msg, hashlib.sha256).hexdigest()


def hash_device(device_id: Optional[str]) -> Optional[str]:
    if not device_id or len(device_id) > 128:
        return None
    return hashlib.sha256(device_id.encode()).hexdigest()[:48]


# ─── Policy ───────────────────────────────────────────────────────────────────

def get_policy(db: Session) -> PlatformLoginSecurity:
    ensure_tables(db)
    policy = db.query(PlatformLoginSecurity).filter(PlatformLoginSecurity.id == 1).first()
    if policy is None:
        policy = PlatformLoginSecurity(id=1, otp_mode="never", captcha_mode="never")
        db.add(policy)
        db.flush()
    return policy


def smtp_configured() -> bool:
    return bool(settings.SMTP_HOST and settings.SMTP_USER and settings.SMTP_PASSWORD)


# ─── Retry limits / lockout ───────────────────────────────────────────────────

def lockout_policy(db: Session) -> tuple[int, int]:
    """(failed attempts before lockout, lockout minutes) from Control Center → Authentication policy."""
    from app.services import platform_controls
    try:
        return max(1, int(platform_controls.value(db, "lockout"))), max(1, int(platform_controls.value(db, "lockMin")))
    except Exception:  # noqa: BLE001 - sign-in must keep working with the configured limits if the settings can't be read
        logger.exception("Control Center lockout policy unreadable; using the configured limits")
        return max(1, int(settings.MAX_LOGIN_ATTEMPTS or 5)), max(1, int(settings.LOCKOUT_DURATION_MINUTES or 30))


def mfa_required(db: Session) -> bool:
    """Control Center "Require MFA for platform staff" is the OTP policy's every-login mode."""
    return get_policy(db).otp_mode == "every_login"


def set_mfa_required(db: Session, required: bool) -> None:
    policy = get_policy(db)
    if required and not smtp_configured():
        raise ValueError("Email isn't configured, so one-time passwords can't be sent – configure SMTP before requiring MFA")
    if required:
        policy.otp_mode = "every_login"
    elif policy.otp_mode == "every_login":
        policy.otp_mode = "new_device"


def _failure_keys(db: Session, username: str, ip: Optional[str]) -> list[tuple[str, int]]:
    keys = [(f"user:{(username or '').strip().lower()[:180]}", lockout_policy(db)[0])]
    if ip:
        keys.append((f"ip:{ip[:180]}", IP_MAX_FAILURES))
    return keys


def lockout_remaining_seconds(db: Session, username: str, ip: Optional[str]) -> int:
    ensure_tables(db)
    now = _now()
    remaining = 0
    for key, _limit in _failure_keys(db, username, ip):
        row = db.get(PlatformLoginFailure, key)
        if row and row.locked_until and row.locked_until > now:
            remaining = max(remaining, int((row.locked_until - now).total_seconds()) + 1)
    return remaining


def record_failure(db: Session, username: str, ip: Optional[str]) -> int:
    """Count a failed password / CAPTCHA / OTP. Returns the username failure count."""
    ensure_tables(db)
    now = _now()
    lock_minutes = lockout_policy(db)[1]
    window = timedelta(minutes=lock_minutes)
    user_failures = 0
    for key, limit in _failure_keys(db, username, ip):
        row = db.get(PlatformLoginFailure, key)
        if row is None:
            row = PlatformLoginFailure(key=key, failures=0, first_failed_at=now)
            db.add(row)
        elif now - row.first_failed_at > window and not (row.locked_until and row.locked_until > now):
            row.failures, row.first_failed_at, row.locked_until = 0, now, None
        row.failures += 1
        if row.failures >= limit:
            row.locked_until = now + timedelta(minutes=lock_minutes)
        if key.startswith("user:"):
            user_failures = row.failures
    db.flush()
    return user_failures


def recent_failures(db: Session, username: str) -> int:
    ensure_tables(db)
    key, _ = _failure_keys(db, username, None)[0]
    row = db.get(PlatformLoginFailure, key)
    if not row or _now() - row.first_failed_at > timedelta(minutes=lockout_policy(db)[1]):
        return 0
    return row.failures


def clear_failures(db: Session, username: str) -> None:
    ensure_tables(db)
    key, _ = _failure_keys(db, username, None)[0]
    row = db.get(PlatformLoginFailure, key)
    if row:
        db.delete(row)


# ─── CAPTCHA ──────────────────────────────────────────────────────────────────

def captcha_required(policy: PlatformLoginSecurity, db: Session, username: str, known_device: bool) -> bool:
    mode = policy.captcha_mode
    if mode == "every_login":
        return True
    if mode == "new_device":
        return not known_device
    if mode == "after_failed":
        return recent_failures(db, username) >= CAPTCHA_AFTER_FAILURES
    return False


def _captcha_svg(text: str) -> str:
    rnd = secrets.SystemRandom()
    width, height = 170, 56
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        f'<rect width="{width}" height="{height}" rx="8" fill="#f1f5f9"/>',
    ]
    for _ in range(6):
        parts.append(
            f'<line x1="{rnd.randint(0, width)}" y1="{rnd.randint(0, height)}" '
            f'x2="{rnd.randint(0, width)}" y2="{rnd.randint(0, height)}" '
            f'stroke="#94a3b8" stroke-width="{rnd.uniform(1, 2):.1f}" opacity="0.7"/>'
        )
    for _ in range(40):
        parts.append(f'<circle cx="{rnd.randint(0, width)}" cy="{rnd.randint(0, height)}" r="1" fill="#64748b" opacity="0.5"/>')
    step = (width - 30) / len(text)
    for index, char in enumerate(text):
        x = 18 + index * step + rnd.uniform(-3, 3)
        y = 38 + rnd.uniform(-5, 5)
        angle = rnd.uniform(-28, 28)
        color = rnd.choice(("#0f172a", "#1e3a8a", "#7c2d12", "#14532d", "#581c87"))
        parts.append(
            f'<text x="{x:.1f}" y="{y:.1f}" font-family="Verdana,Arial,sans-serif" '
            f'font-size="{rnd.randint(24, 30)}" font-weight="700" fill="{color}" '
            f'transform="rotate({angle:.1f} {x:.1f} {y:.1f})">{char}</text>'
        )
    parts.append("</svg>")
    return "data:image/svg+xml;base64," + base64.b64encode("".join(parts).encode()).decode()


def create_captcha(db: Session, ip: Optional[str]) -> dict:
    ensure_tables(db)
    _purge_expired(db)
    challenge_id = secrets.token_urlsafe(24)
    left, right = secrets.randbelow(9) + 1, secrets.randbelow(9) + 1
    answer = str(left + right)
    question = f"{left} + {right} = ?"
    now = _now()
    db.add(PlatformLoginChallenge(
        id=challenge_id, kind="captcha", ip_address=(ip or "")[:64],
        answer_hash=_digest("captcha", challenge_id, answer),
        expires_at=now + timedelta(seconds=CAPTCHA_TTL_SECONDS), created_at=now,
    ))
    db.flush()
    return {
        "captcha_id": challenge_id,
        "question": question,
        "expires_in": CAPTCHA_TTL_SECONDS,
    }


def verify_captcha(db: Session, captcha_id: Optional[str], answer: Optional[str]) -> bool:
    """Single use: the CAPTCHA is consumed whether or not the answer is right."""
    if not captcha_id or not answer:
        return False
    ensure_tables(db)
    row = (
        db.query(PlatformLoginChallenge)
        .filter(PlatformLoginChallenge.id == captcha_id[:64], PlatformLoginChallenge.kind == "captcha")
        .with_for_update()
        .first()
    )
    if row is None or row.consumed_at is not None or row.expires_at < _now():
        return False
    row.consumed_at = _now()
    db.flush()
    normalized = "".join(answer.split()).upper()
    return hmac.compare_digest(row.answer_hash or "", _digest("captcha", row.id, normalized))


# ─── Login challenge + OTP ────────────────────────────────────────────────────

def otp_required(policy: PlatformLoginSecurity, known_device: bool) -> bool:
    if policy.otp_mode == "every_login":
        return True
    if policy.otp_mode == "new_device":
        return not known_device
    return False


def mask_email(email: str) -> str:
    local, _, domain = (email or "").partition("@")
    if not domain:
        return "your email"
    visible = local[:2] if len(local) > 2 else local[:1]
    return f"{visible}{'*' * max(3, len(local) - len(visible))}@{domain}"


def _send_otp_email(admin, code: str, expiry_minutes: int) -> None:
    if not smtp_configured():
        raise RuntimeError("Platform SMTP is not configured")
    message = EmailMessage()
    message["Subject"] = "Your platform sign-in verification code"
    message["From"] = settings.EMAILS_FROM or settings.SMTP_USER
    message["To"] = admin.email
    message.set_content(
        f"Hello {admin.full_name},\n\n"
        f"Your platform sign-in verification code is: {code}\n\n"
        f"It expires in {expiry_minutes} minutes and can be used once. "
        "If you did not try to sign in, change your password immediately."
    )
    with smtplib.SMTP(settings.SMTP_HOST, int(settings.SMTP_PORT), timeout=30) as server:
        server.starttls(context=ssl.create_default_context())
        server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        server.send_message(message)


def _issue_otp(db: Session, challenge: PlatformLoginChallenge, admin, policy: PlatformLoginSecurity) -> None:
    code = f"{secrets.randbelow(1_000_000):06d}"
    now = _now()
    challenge.answer_hash = _digest("otp", challenge.id, code)
    challenge.otp_expires_at = now + timedelta(minutes=policy.otp_expiry_minutes)
    challenge.last_sent_at = now
    challenge.attempts = 0
    db.flush()
    try:
        _send_otp_email(admin, code, policy.otp_expiry_minutes)
    except Exception:
        logger.exception("Could not send platform login OTP for account %s", admin.id)
        challenge.consumed_at = now
        db.flush()
        raise LoginSecurityError(503, "otp_delivery_failed", "We couldn't send the verification code. Please try again later.")


def otp_status(challenge: PlatformLoginChallenge, admin, policy: PlatformLoginSecurity) -> dict:
    now = _now()
    resend_in = 0
    if challenge.last_sent_at:
        resend_in = max(0, policy.otp_resend_cooldown_seconds - int((now - challenge.last_sent_at).total_seconds()))
    return {
        "otp_destination": mask_email(admin.email),
        "otp_expires_in": max(0, int((challenge.otp_expires_at - now).total_seconds())) if challenge.otp_expires_at else 0,
        "resend_available_in": resend_in,
        "resends_remaining": max(0, policy.otp_max_resends - challenge.resend_count),
    }


def start_login_challenge(
    db: Session, admin, policy: PlatformLoginSecurity, *, need_otp: bool, need_password_change: bool,
    device_hash: Optional[str], ip: Optional[str],
) -> PlatformLoginChallenge:
    ensure_tables(db)
    now = _now()
    challenge = PlatformLoginChallenge(
        id=secrets.token_urlsafe(32), kind="login", admin_id=admin.id, device_hash=device_hash,
        ip_address=(ip or "")[:64], otp_required=need_otp, password_change_required=need_password_change,
        expires_at=now + timedelta(minutes=LOGIN_CHALLENGE_TTL_MINUTES), created_at=now,
    )
    db.add(challenge)
    db.flush()
    if need_otp:
        _issue_otp(db, challenge, admin, policy)
    return challenge


def load_login_challenge(db: Session, challenge_id: Optional[str], device_hash: Optional[str]) -> PlatformLoginChallenge:
    """Fetch a live login challenge, locked for update. Raises if unusable."""
    ensure_tables(db)
    row = None
    if challenge_id:
        row = (
            db.query(PlatformLoginChallenge)
            .filter(PlatformLoginChallenge.id == challenge_id[:64], PlatformLoginChallenge.kind == "login")
            .with_for_update()
            .first()
        )
    if row is None or row.consumed_at is not None or row.expires_at < _now():
        raise LoginSecurityError(401, "login_expired", "Your sign-in session has expired. Please sign in again.")
    # Bind the challenge to the browser that entered the password.
    if row.device_hash and row.device_hash != device_hash:
        raise LoginSecurityError(401, "login_expired", "Your sign-in session has expired. Please sign in again.")
    return row


def verify_otp(db: Session, challenge: PlatformLoginChallenge, policy: PlatformLoginSecurity, code: str) -> None:
    if not challenge.otp_required or challenge.otp_verified:
        raise LoginSecurityError(400, "otp_not_pending", "No verification code is pending for this sign-in.")
    if not challenge.otp_expires_at or challenge.otp_expires_at < _now():
        raise LoginSecurityError(400, "otp_expired", "The verification code has expired. Request a new code.")
    normalized = "".join(ch for ch in (code or "") if ch.isdigit())
    if len(normalized) == 6 and hmac.compare_digest(challenge.answer_hash or "", _digest("otp", challenge.id, normalized)):
        challenge.otp_verified = True
        challenge.answer_hash = None  # the code can't be replayed
        db.flush()
        return
    challenge.attempts += 1
    remaining = policy.otp_max_attempts - challenge.attempts
    if remaining <= 0:
        challenge.consumed_at = _now()
        db.flush()
        raise LoginSecurityError(429, "otp_locked", "Too many incorrect codes. Please sign in again.")
    db.flush()
    raise LoginSecurityError(400, "otp_invalid", f"Incorrect verification code. {remaining} attempt(s) remaining.", attempts_remaining=remaining)


def resend_otp(db: Session, challenge: PlatformLoginChallenge, admin, policy: PlatformLoginSecurity) -> None:
    if not challenge.otp_required or challenge.otp_verified:
        raise LoginSecurityError(400, "otp_not_pending", "No verification code is pending for this sign-in.")
    if challenge.resend_count >= policy.otp_max_resends:
        raise LoginSecurityError(429, "otp_resend_limit", "You've reached the resend limit. Please sign in again.")
    if challenge.last_sent_at:
        wait = policy.otp_resend_cooldown_seconds - int((_now() - challenge.last_sent_at).total_seconds())
        if wait > 0:
            raise LoginSecurityError(429, "otp_resend_cooldown", f"Please wait {wait} seconds before requesting a new code.", retry_after=wait)
    challenge.resend_count += 1
    _issue_otp(db, challenge, admin, policy)


def ready_for_session(challenge: PlatformLoginChallenge) -> bool:
    return (not challenge.otp_required or challenge.otp_verified) and not challenge.password_change_required


def consume(db: Session, challenge: PlatformLoginChallenge) -> None:
    challenge.consumed_at = _now()
    db.flush()


def _purge_expired(db: Session) -> None:
    cutoff = _now() - timedelta(days=1)
    db.query(PlatformLoginChallenge).filter(PlatformLoginChallenge.expires_at < cutoff).delete(synchronize_session=False)
