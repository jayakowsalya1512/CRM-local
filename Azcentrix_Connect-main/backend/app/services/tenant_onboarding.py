"""Onboarding & Provisioning: the 8-step provisioning blueprint for each tenant.

Automatic steps are detected from the tenant's real state (master record, MariaDB database, seeded
catalog, approval workflows). Manual steps are admin confirmations, auto-completed when real evidence
exists (HTTPS reachable, admin has signed in, business data present). Each completion is stored once in
`tenant_onboarding_steps` with its time and actor, which drives progress and the KPIs.
"""

from __future__ import annotations

import html
import logging
import smtplib
import ssl
import time
from email.message import EmailMessage
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import requests
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_tenant_session
from app.models.tenant import Feature, PlatformSetting, Tenant, TenantFeature
from app.models.tenant_hierarchy import TenantOnboardingStep
from app.services import platform_infrastructure
from app.services.tenant_hierarchy import RECORD_TABLES, _existing_tables

logger = logging.getLogger(__name__)

STEPS: list[tuple[str, str, str]] = [
    ("account", "Account created", "automatic"),
    ("database", "Tenant database provisioned", "automatic"),
    ("masters", "Master data seeded", "automatic"),
    ("workflow", "Workflow template applied", "automatic"),
    ("domain", "Domain & SSL", "manual"),
    ("admin", "Admin invited", "manual"),
    ("data", "Data imported", "manual"),
    ("golive", "Go-live checks", "manual"),
]
STEP_KEYS = [key for key, _, _ in STEPS]
STUCK_AFTER = timedelta(hours=48)
BLUEPRINT_SETTING = "onboarding_step_enabled:"


def blueprint(db: Session) -> dict[str, bool]:
    """Which blueprint steps are switched on (platform settings; every step defaults to on)."""
    rows = {r.key: r.value_bool for r in db.query(PlatformSetting).filter(PlatformSetting.key.like(BLUEPRINT_SETTING + "%")).all()}
    return {key: bool(rows.get(BLUEPRINT_SETTING + key, True)) for key in STEP_KEYS}


def set_step_enabled(db: Session, key: str, enabled: bool) -> None:
    if key not in STEP_KEYS:
        raise ValueError("Unknown blueprint step")
    row = db.get(PlatformSetting, BLUEPRINT_SETTING + key)
    if row is None:
        db.add(PlatformSetting(key=BLUEPRINT_SETTING + key, value_bool=enabled))
    else:
        row.value_bool = enabled


_HTTPS_CACHE: dict[str, tuple[float, tuple[bool, str]]] = {}
_HTTPS_TTL_SECONDS = 300


def _https_ok(url: str | None) -> tuple[bool, str]:
    if not url:
        return False, "No public tenant URL configured"
    cached = _HTTPS_CACHE.get(url)
    if cached and time.monotonic() - cached[0] < _HTTPS_TTL_SECONDS:
        return cached[1]
    result = _https_probe(url)
    _HTTPS_CACHE[url] = (time.monotonic(), result)
    return result


def _https_probe(url: str) -> tuple[bool, str]:
    try:
        response = requests.get(url, timeout=4, allow_redirects=True)
        return response.status_code < 500, f"HTTPS {response.status_code} at {url}"
    except requests.exceptions.SSLError as exc:
        return False, f"SSL error: {exc.__class__.__name__}"
    except Exception as exc:
        return False, f"Unreachable: {exc.__class__.__name__}"


def _evidence(tenant: Tenant, databases: dict, workspace_url: str | None, keys: set[str]) -> dict[str, tuple[bool, str]]:
    """Real-state checks for the requested step keys."""
    result: dict[str, tuple[bool, str]] = {}
    if "account" in keys:
        result["account"] = (True, f"Tenant record created {tenant.created_at:%d %b %Y}")
    if "database" in keys:
        info = databases.get(tenant.db_name)
        result["database"] = (bool(info), f"{tenant.db_name} on {info['server']}" if info else f"{tenant.db_name} not found on any server")
    tenant_keys = keys & {"masters", "workflow", "admin", "data"}
    if tenant_keys and tenant.db_name in databases:
        session = get_tenant_session(tenant.slug)
        try:
            present = _existing_tables(session, ["roles", "modules", "approval_rules", *[name for name, _ in RECORD_TABLES]])
            count = lambda table: int(session.execute(text(f"SELECT COUNT(*) FROM `{table}`")).scalar_one()) if table in present else 0
            if "masters" in keys:
                roles, modules = count("roles"), count("modules")
                result["masters"] = (roles > 0 and modules > 0, f"{roles} roles, {modules} modules")
            if "workflow" in keys:
                rules = count("approval_rules")
                result["workflow"] = (rules > 0, f"{rules} approval workflow rule(s)")
            if "admin" in keys:
                last = session.execute(text("SELECT last_login FROM users WHERE email = :e"), {"e": tenant.admin_email}).scalar()
                result["admin"] = (last is not None, f"Admin signed in {last:%d %b %Y %H:%M}" if last else "Admin has not signed in yet")
            if "data" in keys:
                counts = {label: count(name) for name, label in RECORD_TABLES}
                total = sum(counts.values())
                result["data"] = (total > 0, ", ".join(f"{v} {k.lower()}" for k, v in counts.items()))
        except Exception:
            logger.warning("Onboarding checks failed for %s", tenant.slug, exc_info=True)
        finally:
            session.close()
    if "domain" in keys:
        result["domain"] = _https_ok(workspace_url)
    return result


PROVISIONED_AT_CREATION = {"account", "database", "masters"}


def _record(db: Session, tenant_id: int, key: str, actor: str, note: str, at: datetime | None = None) -> TenantOnboardingStep:
    row = TenantOnboardingStep(tenant_id=tenant_id, step_key=key, completed_at=at or datetime.now(), completed_by=actor, note=note)
    db.add(row)
    db.flush()
    return row


def _recorded(db: Session, tenant_ids: list[int]) -> dict[int, dict[str, TenantOnboardingStep]]:
    rows: dict[int, dict[str, TenantOnboardingStep]] = {tid: {} for tid in tenant_ids}
    for r in db.query(TenantOnboardingStep).filter(TenantOnboardingStep.tenant_id.in_(tenant_ids or [0])).all():
        rows.setdefault(r.tenant_id, {})[r.step_key] = r
    return rows


def _state(db: Session, tenant: Tenant, rows: dict[str, TenantOnboardingStep], evidence: dict[str, tuple[bool, str]], enabled: dict[str, bool]) -> dict:
    """Progress through the blueprint; newly evidenced steps are recorded as completed automatically."""
    for key, (ok, note) in evidence.items():
        if ok and key not in rows:
            # Steps that happen during provisioning are dated to the tenant's creation, not to when we first saw them.
            rows[key] = _record(db, tenant.id, key, "auto", note, tenant.created_at if key in PROVISIONED_AT_CREATION else None)
    active = [key for key in STEP_KEYS if enabled[key]]
    progress = next((i for i, key in enumerate(active) if key not in rows), len(active))
    next_key = active[progress] if progress < len(active) else None
    chain = [rows[key].completed_at for key in active[:progress]]
    return {
        "progress": progress,
        "total": len(active),
        "next_key": next_key,
        "steps": [{"key": key, "label": label, "kind": kind, "enabled": enabled[key], "done": key in rows,
                   "complete": key in active[:progress],
                   "completed_at": rows[key].completed_at if key in rows else None,
                   "completed_by": rows[key].completed_by if key in rows else None,
                   "note": rows[key].note if key in rows else None} for key, label, kind in STEPS],
        "next_step": next((label for key, label, _ in STEPS if key == next_key), None),
        "last_activity": max(chain + [tenant.created_at]),
        "live_at": (rows["golive"].completed_at if enabled["golive"] and "golive" in rows
                    else max(chain) if progress == len(active) and chain else None),
    }


def _pending(rows: dict[str, TenantOnboardingStep], enabled: dict[str, bool]) -> set[str]:
    return {key for key in STEP_KEYS if key not in rows and key != "golive" and enabled[key]}


def pipeline(db: Session, tenants: list[Tenant], workspace_url) -> dict:
    databases = platform_infrastructure.database_placements()["databases"]
    recorded = _recorded(db, [t.id for t in tenants])
    enabled = blueprint(db)
    # Read-only checks (tenant databases, HTTPS) run in parallel; recording happens on this session afterwards.
    with ThreadPoolExecutor(max_workers=8) as pool:
        evidence = list(pool.map(lambda t: _evidence(t, databases, workspace_url(t), _pending(recorded[t.id], enabled)), tenants))
    rows = [{"id": t.id, "name": t.name, "slug": t.slug, "status": t.status, "created_at": t.created_at, **_state(db, t, recorded[t.id], ev, enabled)}
            for t, ev in zip(tenants, evidence)]
    db.commit()
    now = datetime.now()
    live = [r for r in rows if r["live_at"]]
    in_onboarding = [r for r in rows if r["progress"] < r["total"]]
    required = [k for k in ("database", "masters") if enabled[k]]
    provisioned = [r for r in rows if all(next(s for s in r["steps"] if s["key"] == k)["done"] for k in required)]
    return {
        "steps": [{"key": key, "label": label, "kind": kind, "enabled": enabled[key]} for key, label, kind in STEPS],
        "tenants": rows,
        "kpis": {
            "in_onboarding": len(in_onboarding),
            "avg_go_live_days": round(sum((r["live_at"] - r["created_at"]).total_seconds() for r in live) / len(live) / 86400, 1) if live else None,
            "go_live_count": len(live),
            "provisioning_success": round(len(provisioned) / len(rows) * 100, 1) if rows else None,
            "stuck": sum(1 for r in in_onboarding if now - r["last_activity"] > STUCK_AFTER),
        },
    }


def run_next_step(db: Session, tenant: Tenant, actor: str, workspace_url: str | None) -> dict:
    """Perform (automatic) or confirm (manual) the tenant's next blueprint step."""
    databases = platform_infrastructure.database_placements()["databases"]
    rows = _recorded(db, [tenant.id])[tenant.id]
    enabled = blueprint(db)
    state = _state(db, tenant, rows, _evidence(tenant, databases, workspace_url, _pending(rows, enabled)), enabled)
    if state["next_key"] is None:
        return {"step": None, "message": "Tenant is already live"}
    key, label, kind = next(step for step in STEPS if step[0] == state["next_key"])
    if key == "database":
        raise ValueError(f"Database {tenant.db_name} was not found on any database server. Re-provision the tenant from Tenant Onboarding.")
    if key == "masters":
        _seed_masters(db, tenant)
        ok, note = _evidence(tenant, databases, workspace_url, {"masters"}).get("masters", (False, "Check failed"))
        if not ok:
            raise ValueError(f"Seeding ran but master data is still incomplete ({note}).")
        _record(db, tenant.id, key, actor, f"Seeded by platform admin · {note}")
    elif key == "workflow":
        _record(db, tenant.id, key, actor, "Blank template confirmed – approval workflows configured by the tenant admin")
    else:
        evidence = _evidence(tenant, databases, workspace_url, {key}).get(key)
        detail = f" · check: {evidence[1]}" if evidence else ""
        _record(db, tenant.id, key, actor, f"Confirmed by {actor}{detail}")
    db.commit()
    return {"step": label, "kind": kind, "message": f"{label} completed"}


def _seed_masters(db: Session, tenant: Tenant) -> None:
    """Re-run the tenant catalog seeding used at provisioning (modules, permissions, admin role)."""
    from app.services.tenant_module_service import sync_tenant_runtime_catalog

    feature_ids = [row.feature_id for row in db.query(TenantFeature).filter(TenantFeature.tenant_id == tenant.id, TenantFeature.enabled == True).all()]  # noqa: E712
    keys = [f.key for f in db.query(Feature).filter(Feature.id.in_(feature_ids)).all()] if feature_ids else None
    session = get_tenant_session(tenant.slug)
    session.info["tenant_slug"] = tenant.slug
    try:
        sync_tenant_runtime_catalog(session, enabled_feature_keys=keys, assign_permissions_to_admin_role=True)
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


# ─── Admin invitation ───────────────────────────────────────────────────────

INVITATION_VALID_FOR = timedelta(hours=72)


class InvitationError(Exception):
    pass


def _invitation_bodies(full_name: str, tenant_name: str, url: str) -> tuple[str, str]:
    hours = int(INVITATION_VALID_FOR.total_seconds() // 3600)
    text_body = (
        f"Hello {full_name or 'Administrator'},\n\n"
        f"You have been invited as the administrator of {tenant_name}.\n"
        f"Set your password to activate your account:\n\n{url}\n\n"
        f"This invitation link expires in {hours} hours and can be used once."
    )
    html_body = (
        f"<p>Hello {html.escape(full_name or 'Administrator')},</p>"
        f"<p>You have been invited as the administrator of <b>{html.escape(tenant_name)}</b>.</p>"
        f'<p><a href="{html.escape(url)}" style="display:inline-block;padding:10px 16px;background:#5646C2;color:#fff;border-radius:4px;text-decoration:none">Set your password</a></p>'
        f"<p>This invitation link expires in {hours} hours and can be used once.</p>"
    )
    return text_body, html_body


def _send_via_platform_smtp(to_email: str, subject: str, text_body: str, html_body: str) -> None:
    from app.core.config import settings
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = settings.EMAILS_FROM or settings.SMTP_USER
    message["To"] = to_email
    message.set_content(text_body)
    message.add_alternative(html_body, subtype="html")
    with smtplib.SMTP(settings.SMTP_HOST, int(settings.SMTP_PORT), timeout=30) as server:
        server.starttls(context=ssl.create_default_context())
        server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        server.send_message(message)


def send_email(tenant: Tenant, to_email: str, subject: str, text_body: str, html_body: str) -> str:
    """Send through the tenant's own SMTP when configured, otherwise the platform SMTP. Returns the channel used."""
    from app.services.platform_login_security import smtp_configured
    from app.services.tenant_email_service import get_missing_tenant_smtp_fields, send_tenant_email
    try:
        if not get_missing_tenant_smtp_fields(tenant):
            send_tenant_email(tenant=tenant, to_email=to_email, subject=subject, text_body=text_body, html_body=html_body)
            return "tenant SMTP"
        if smtp_configured():
            _send_via_platform_smtp(to_email, subject, text_body, html_body)
            return "platform SMTP"
    except Exception as exc:
        logger.exception("Email to %s failed", to_email)
        raise InvitationError(f"The email could not be sent: {exc.__class__.__name__}") from exc
    raise InvitationError("No email server is configured (tenant SMTP or platform SMTP_* settings)")


def send_admin_invitation(db: Session, request, tenant: Tenant, actor: str) -> str:
    """Email the tenant administrator a one-time set-password link (tenant SMTP, else platform SMTP)."""
    from app.core.security import create_password_reset_token, password_reset_token_fingerprint
    from app.models.all_models import User
    from app.services.password_reset_service import PASSWORD_RESET_PURPOSE_ADMIN, build_password_reset_url

    session = get_tenant_session(tenant.slug)
    try:
        user = session.query(User).filter(User.email == tenant.admin_email).first()
        if not user:
            raise InvitationError(f"Administrator {tenant.admin_email} was not found in {tenant.db_name}")
        token = create_password_reset_token(
            user_id=user.id, tenant_id=tenant.id, tenant_slug=tenant.slug, email=user.email,
            password_fingerprint=password_reset_token_fingerprint(user.hashed_password),
            purpose=PASSWORD_RESET_PURPOSE_ADMIN, expires_delta=INVITATION_VALID_FOR,
        )
        full_name = user.full_name
    finally:
        session.close()
    url = build_password_reset_url(request, token)
    text_body, html_body = _invitation_bodies(full_name, tenant.name, url)
    subject = f"You're invited to administer {tenant.name}"
    channel = send_email(tenant, tenant.admin_email, subject, text_body, html_body)
    note = f"Invitation emailed to {tenant.admin_email} via {channel} by {actor}"
    existing = db.query(TenantOnboardingStep).filter(TenantOnboardingStep.tenant_id == tenant.id, TenantOnboardingStep.step_key == "admin").first()
    if existing:
        existing.note, existing.completed_at, existing.completed_by = note, datetime.now(), actor
    else:
        _record(db, tenant.id, "admin", actor, note)
    db.commit()
    return note


def record_workflow_choice(db: Session, tenant: Tenant, actor: str, note: str) -> None:
    if not db.query(TenantOnboardingStep).filter(TenantOnboardingStep.tenant_id == tenant.id, TenantOnboardingStep.step_key == "workflow").first():
        _record(db, tenant.id, "workflow", actor, note)
        db.commit()
