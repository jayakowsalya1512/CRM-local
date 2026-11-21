"""Platform staff password policy from Control Center → Authentication policy (platform-only).

Applied on top of the shared ``validate_password_strength`` rules wherever a platform staff password is set:

* ``pwMin``  – minimum length (never below the application minimum).
* ``pwHist`` – the new password may not match the current one or any of the last N passwords (0 = off).
* ``pwRot``  – a password older than N days must be changed at the next sign-in (0 = never).

Passwords are kept only as the same bcrypt hashes the accounts use (``platform_password_history``); nothing readable is
stored or returned. When the policy first runs, accounts with no history start their rotation clock at that moment,
because their real last change time was never recorded.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Session

from app.core.security import verify_password
from app.database import Base, master_engine
from app.models.tenant import PlatformSetting, SuperAdmin
from app.services import platform_controls as controls

KEEP = 24   # history rows kept per account (the highest pwHist the Control Center accepts)


class PlatformPasswordHistory(Base):
    """A password (bcrypt hash) a platform staff account has had, and when it was set."""
    __tablename__ = "platform_password_history"
    __table_args__ = (Index("ix_platform_password_history_admin_set", "admin_id", "set_at"),)
    id = Column(Integer, primary_key=True)
    admin_id = Column(Integer, ForeignKey("super_admins.id", ondelete="CASCADE"), nullable=False)
    hashed_password = Column(String(255), nullable=False)
    set_at = Column(DateTime, nullable=False)


_ready: dict[str, bool] = {}


def ensure_schema() -> None:
    if not _ready.get("schema"):
        PlatformPasswordHistory.__table__.create(bind=master_engine, checkfirst=True)
        _ready["schema"] = True


class PasswordPolicyError(ValueError):
    pass


def _history(db: Session, admin_id: int, limit: int) -> list[PlatformPasswordHistory]:
    ensure_schema()
    return (db.query(PlatformPasswordHistory).filter(PlatformPasswordHistory.admin_id == admin_id)
            .order_by(PlatformPasswordHistory.set_at.desc(), PlatformPasswordHistory.id.desc()).limit(limit).all())


def check(db: Session, admin: Optional[SuperAdmin], new_password: str) -> None:
    """Raise PasswordPolicyError when ``new_password`` breaks the Control Center policy for ``admin`` (None = new account)."""
    minimum = int(controls.value(db, "pwMin"))
    if len(new_password or "") < minimum:
        raise PasswordPolicyError(f"Password must be at least {minimum} characters")
    if admin is None:
        return
    keep = int(controls.value(db, "pwHist"))
    if keep <= 0:
        return
    hashes = [admin.hashed_password] + [h.hashed_password for h in _history(db, admin.id, keep) if h.hashed_password != admin.hashed_password]
    if any(verify_password(new_password, h) for h in hashes[:keep]):
        raise PasswordPolicyError(f"Choose a password you haven't used for your last {keep} password{'s' if keep != 1 else ''}")


def record(db: Session, admin: SuperAdmin, at: Optional[datetime] = None) -> None:
    """Remember the account's current (just set) password hash; keep only the newest KEEP rows."""
    ensure_schema()
    db.add(PlatformPasswordHistory(admin_id=admin.id, hashed_password=admin.hashed_password, set_at=at or datetime.utcnow()))
    db.flush()
    stale = [h.id for h in (db.query(PlatformPasswordHistory.id).filter(PlatformPasswordHistory.admin_id == admin.id)
                              .order_by(PlatformPasswordHistory.set_at.desc(), PlatformPasswordHistory.id.desc()).offset(KEEP).all())]
    if stale:
        db.query(PlatformPasswordHistory).filter(PlatformPasswordHistory.id.in_(stale)).delete(synchronize_session=False)


def password_set_at(db: Session, admin: SuperAdmin) -> datetime:
    """When the current password was set. A password changed outside the policy (or never recorded) starts now."""
    latest = _history(db, admin.id, 1)
    if not latest or latest[0].hashed_password != admin.hashed_password:
        record(db, admin)
        return datetime.utcnow()
    return latest[0].set_at


def rotation_due(db: Session, admin: SuperAdmin) -> bool:
    days = int(controls.value(db, "pwRot"))
    return days > 0 and datetime.utcnow() - password_set_at(db, admin) > timedelta(days=days)


def require_change(db: Session, admin: SuperAdmin) -> None:
    """Make the next sign-in step a password change (the same pending flag the first-sign-in change uses)."""
    key = f"platform_first_change_{admin.id}"
    row = db.get(PlatformSetting, key)
    if row is None:
        db.add(PlatformSetting(key=key, value_bool=True))
    else:
        row.value_bool = True
