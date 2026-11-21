"""
Centralized logging: auth.log, system.log, error.log, audit.log
+ DB logging: audit_logs, activity_logs, error_logs tables
"""
import logging
import os
import traceback
from logging.handlers import RotatingFileHandler
from app.core.config import settings

os.makedirs(settings.LOG_DIR, exist_ok=True)


# ─── File logging setup ───────────────────────────────────────────────────────

def _make_handler(filename: str, level=logging.DEBUG) -> RotatingFileHandler:
    handler = RotatingFileHandler(
        os.path.join(settings.LOG_DIR, filename),
        maxBytes=10 * 1024 * 1024,  # 10 MB
        backupCount=7,
        encoding="utf-8",
    )
    handler.setLevel(level)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s | %(levelname)-8s | %(name)s — %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    return handler


def setup_logging():
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if settings.DEBUG else logging.INFO)

    # Console handler
    console = logging.StreamHandler()
    console.setLevel(logging.DEBUG if settings.DEBUG else logging.INFO)
    console.setFormatter(logging.Formatter(
        "%(asctime)s | %(levelname)-8s | %(name)s — %(message)s",
        datefmt="%H:%M:%S",
    ))
    root.addHandler(console)

    # File handlers
    root.addHandler(_make_handler("system.log", logging.INFO))
    root.addHandler(_make_handler("error.log", logging.ERROR))

    # Auth logger
    auth_logger = logging.getLogger("auth")
    auth_logger.addHandler(_make_handler("auth.log"))

    # Audit logger
    audit_logger = logging.getLogger("audit")
    audit_logger.addHandler(_make_handler("audit.log"))


auth_logger   = logging.getLogger("auth")
audit_logger  = logging.getLogger("audit")
system_logger = logging.getLogger("system")
_db_logger    = logging.getLogger(__name__)


# ─── File-based helpers (unchanged) ──────────────────────────────────────────

def log_auth_event(event: str, username: str, ip: str, success: bool, detail: str = ""):
    level = logging.INFO if success else logging.WARNING
    auth_logger.log(level, f"AUTH | {event} | user={username} | ip={ip} | success={success} | {detail}")


def log_audit(
    tenant_id: int | None,
    user_id: int | None,
    module: str,
    action: str,
    ip: str,
    detail: str = "",
):
    """Original file-based audit log — kept for backward compatibility."""
    audit_logger.info(
        f"AUDIT | tenant={tenant_id} | user={user_id} | module={module} | action={action} | ip={ip} | {detail}"
    )


# ─── User-agent parser ────────────────────────────────────────────────────────

import re

def parse_user_agent(ua: str) -> str:
    """Return clean 'Browser · OS' string instead of raw UA.
    Example: 'Chrome 145 · Windows 10/11'
    Use this when storing user_agent in login_logs.
    """
    if not ua:
        return "Unknown"

    # Browser — order matters (Edge before Chrome, Chrome before Safari)
    browser = "Unknown"
    if m := re.search(r'Edg(?:e)?/([\d.]+)', ua):
        browser = f"Edge {m.group(1).split('.')[0]}"
    elif m := re.search(r'OPR/([\d.]+)', ua):
        browser = f"Opera {m.group(1).split('.')[0]}"
    elif m := re.search(r'Firefox/([\d.]+)', ua):
        browser = f"Firefox {m.group(1).split('.')[0]}"
    elif m := re.search(r'Chrome/([\d.]+)', ua):
        browser = f"Chrome {m.group(1).split('.')[0]}"
    elif 'Safari' in ua:
        if m := re.search(r'Version/([\d.]+)', ua):
            browser = f"Safari {m.group(1).split('.')[0]}"
        else:
            browser = "Safari"
    elif 'MSIE' in ua or 'Trident' in ua:
        browser = "Internet Explorer"

    # OS
    os_name = "Unknown OS"
    if 'Windows NT 10' in ua:
        os_name = "Windows 10/11"
    elif 'Windows NT 6.3' in ua:
        os_name = "Windows 8.1"
    elif 'Windows NT 6.1' in ua:
        os_name = "Windows 7"
    elif 'Windows' in ua:
        os_name = "Windows"
    elif 'Mac OS X' in ua:
        if m := re.search(r'Mac OS X ([\d_]+)', ua):
            os_name = f"macOS {m.group(1).replace('_', '.')}"
        else:
            os_name = "macOS"
    elif 'Android' in ua:
        if m := re.search(r'Android ([\d.]+)', ua):
            os_name = f"Android {m.group(1)}"
        else:
            os_name = "Android"
    elif 'iPhone' in ua or 'iPad' in ua:
        os_name = "iOS"
    elif 'Linux' in ua:
        os_name = "Linux"

    return f"{browser} · {os_name}"


# ─── DB logging helpers ───────────────────────────────────────────────────────
# These write to your actual database tables (audit_logs, activity_logs, error_logs).
# Always call BEFORE db.commit() so logs are part of the same transaction.

MODULE_META = {
    "customers": {"icon": "🏢", "color": "#EFF6FF"},
    "leads":     {"icon": "🎯", "color": "#F0FDF4"},
    "contacts":  {"icon": "👤", "color": "#FFF7ED"},
    "deals":     {"icon": "💰", "color": "#FEFCE8"},
    "tasks":     {"icon": "✅", "color": "#F5F3FF"},
    "users":     {"icon": "👥", "color": "#FDF2F8"},
    "default":   {"icon": "📌", "color": "#EFF6FF"},
}

ACTION_VERBS = {
    "create":        "created",
    "update":        "updated",
    "delete":        "deleted",
    "status_change": "status changed",
    "login":         "logged in",
    "logout":        "logged out",
}


def model_snapshot(instance) -> dict:
    """Serialize every column of a SQLAlchemy model instance into a JSON-safe dict,
    for use as old_data/new_data on an audit log row (e.g. the full record just
    before it's deleted). Works for any mapped model — no per-module field list to
    maintain."""
    from decimal import Decimal
    from datetime import date, datetime

    snapshot = {}
    for column in instance.__table__.columns:
        value = getattr(instance, column.name, None)
        if isinstance(value, Decimal):
            value = float(value)
        elif isinstance(value, (datetime, date)):
            value = value.isoformat()
        elif isinstance(value, (bytes, bytearray)):
            value = None
        snapshot[column.name] = value
    return snapshot


def log_audit_db(
    db,                          # Session — not typed to avoid circular import
    user_id: int | None,
    module: str,
    action: str,
    record_id: int | None,
    ip: str,
    description: str = "",
    old_data: dict | None = None,
    new_data: dict | None = None,
    record_name: str | None = None,
):
    """Write one row to audit_logs table."""
    try:
        from fastapi.encoders import jsonable_encoder
        from app.models.all_models import AuditLog
        db.add(AuditLog(
            user_id=user_id,
            module=module,
            action=action,
            record_id=record_id,
            record_name=record_name,
            old_data=jsonable_encoder(old_data),
            new_data=jsonable_encoder(new_data),
            description=description or f"{module} {action}",
            ip_address=ip,
        ))
        db.flush()
    except Exception as e:
        _db_logger.error(f"Failed to write audit_log: {e}")


def log_activity_db(
    db,
    user_id: int | None,
    module: str,
    action: str,
    record_id: int | None,
    description: str,
):
    """Write one row to activity_logs table."""
    meta = MODULE_META.get(module, MODULE_META["default"])
    try:
        from app.models.all_models import ActivityLog
        db.add(ActivityLog(
            user_id=user_id,
            module=module,
            action=action,
            record_id=record_id,
            description=description,
            icon=meta["icon"],
            color=meta["color"],
        ))
        db.flush()
    except Exception as e:
        _db_logger.error(f"Failed to write activity_log: {e}")


def log_error_db(
    db,
    user_id: int | None,
    module: str,
    error: Exception,
    request_data: dict | None = None,
):
    """Write one row to error_logs table. Call from except blocks."""
    try:
        from app.models.all_models import ErrorLog
        db.add(ErrorLog(
            user_id=user_id,
            module=module,
            error_type=type(error).__name__,
            message=str(error),
            stack_trace=traceback.format_exc(),
            request_data=request_data,
        ))
        db.flush()
    except Exception as e:
        _db_logger.error(f"Failed to write error_log: {e}")


def log_module_action(
    db,
    user_id: int,
    module: str,          # e.g. "customers", "leads", "deals"
    action: str,          # "create" | "update" | "delete" | "status_change"
    record_id: int | None,
    record_name: str | None = None,
    ip: str = "",
    old_data: dict | None = None,
    new_data: dict | None = None,
    description: str | None = None,
):
    """
    Single call that writes BOTH audit_log + activity_log.
    Use this in every router for any create/update/delete action.

    Example:
        log_module_action(
            db=db, user_id=current_user.id,
            module="customers", action="create",
            record_id=customer.id, record_name=customer.customer_name,
            ip=get_request_ip(request), new_data=data.model_dump(),
        )
    """
    verb = ACTION_VERBS.get(action, action)
    label = record_name or (f"#{record_id}" if record_id is not None else module)
    description = description or f"{module.capitalize().rstrip('s')} '{label}' {verb}"

    log_audit_db(
        db=db, user_id=user_id, module=module, action=action,
        record_id=record_id, ip=ip, description=description,
        old_data=old_data, new_data=new_data, record_name=record_name,
    )
    log_activity_db(
        db=db, user_id=user_id, module=module, action=action,
        record_id=record_id, description=description,
    )
