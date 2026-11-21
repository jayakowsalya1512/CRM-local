"""Trust & Safety (Governance): abuse cases, acceptable-use enforcement, user / tenant enforcement and access blocks.

Everything is stored in the platform database. Tenant users are read from and changed in each tenant's own database
(one query per tenant database, run in parallel); nothing about one tenant is written to another.

What the platform can and cannot do is reported as it happened: an email counts as sent only when the SMTP server
accepted it, sessions count as revoked by the rows actually updated, and a tenant's legal-hold export counts as
preserved only once the export job has finished (its SHA-256 is then on the evidence row).
"""

from __future__ import annotations

import hashlib
import json
import logging
import smtplib
import ssl
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from email.message import EmailMessage
from typing import Optional

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import hash_device_uuid
from app.database import get_tenant_session, master_engine
from app.models.platform_trust_safety import (PlatformAbuseCase, PlatformAccessBlock, PlatformAupPolicy, PlatformCaseEvent,
                                              PlatformCaseEvidence, PlatformEnforcementAction)
from app.models.tenant import Tenant
from app.models.tenant_hierarchy import TenantExportJob
from app.services.tenant_hierarchy import _existing_tables

logger = logging.getLogger(__name__)

CATEGORIES = ["Spam / phishing", "Data scraping", "Illegal content", "Sanctions / export", "Fraud", "Credential abuse"]
SEVERITIES = ["Low", "Medium", "High", "Critical"]
OPEN_STATUSES = ("Under review", "Investigating", "Escalated")
USER_REASONS = ["Illegal activity", "Fraud", "Abuse / harassment", "Sanctions or export violation", "Security threat", "Terms-of-service violation"]
TENANT_REASONS = ["Illegal activity", "Fraud", "Non-payment", "Terms violation", "Sanctions"]
OWNED_RECORDS = ("customers", "leads", "tenders")        # tables whose assigned_to is the record owner
GRACE_DAYS = 30

# Prototype acceptable-use policies. "queue" = approval requests filed for a new case in the category when the policy is on.
POLICIES = [
    {"key": "illegal", "name": "Illegal content (CSAM, terrorism, etc.)", "action": "Terminate + report", "category": "Illegal content",
     "queue": ["ts_terminate_tenant"], "unsupported": "Reporting to authorities is not automatic – staff log it from the case"},
    {"key": "fraud", "name": "Fraud / chargeback abuse", "action": "Suspend + review", "category": "Fraud", "queue": ["ts_suspend_tenant"], "unsupported": None},
    {"key": "phishing", "name": "Phishing / malware", "action": "Quarantine + suspend", "category": "Spam / phishing", "queue": ["ts_suspend_tenant"],
     "unsupported": "Content quarantine is not supported"},
    {"key": "scraping", "name": "Data scraping", "action": "Throttle + warn", "category": "Data scraping", "queue": ["ts_warn_tenant"],
     "unsupported": "Per-tenant API throttling is not supported"},
    {"key": "sanctions", "name": "Sanctions / export violation", "action": "Suspend + legal", "category": "Sanctions / export", "queue": ["ts_suspend_tenant"],
     "unsupported": None, "escalate": True},
    {"key": "credential", "name": "Credential abuse", "action": "Lock + MFA reset", "category": "Credential abuse", "queue": [],
     "unsupported": "Cases are filed against a tenant, not a user, and tenant MFA is email OTP – lock the user from Find and act on a user"},
]
POLICY_BY_KEY = {p["key"]: p for p in POLICIES}
QUEUE_LABELS = {"ts_suspend_tenant": "Suspend tenant", "ts_terminate_tenant": "Terminate tenant", "ts_warn_tenant": "Warn tenant admin"}

_ready: dict[str, bool] = {}


def ensure_schema() -> None:
    if _ready.get("schema"):
        return
    for model in (PlatformAbuseCase, PlatformCaseEvent, PlatformCaseEvidence, PlatformAupPolicy, PlatformEnforcementAction, PlatformAccessBlock):
        model.__table__.create(bind=master_engine, checkfirst=True)
    _ready["schema"] = True


class TrustSafetyError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _canonical(data) -> str:
    return json.dumps(data, sort_keys=True, default=str, ensure_ascii=False)


def send_mail(to: Optional[str], subject: str, body: str) -> tuple[bool, str]:
    """Platform SMTP. Returns (sent, what happened) – sent only when the server accepted the message."""
    if not to:
        return False, "no email address on record"
    if not (settings.SMTP_HOST and settings.SMTP_USER and settings.SMTP_PASSWORD):
        return False, "platform email (SMTP) is not configured"
    message = EmailMessage()
    message["Subject"], message["From"], message["To"] = subject, settings.EMAILS_FROM or settings.SMTP_USER, to
    message.set_content(body)
    try:
        with smtplib.SMTP(settings.SMTP_HOST, int(settings.SMTP_PORT), timeout=30) as server:
            server.starttls(context=ssl.create_default_context())
            server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            server.send_message(message)
    except Exception as exc:  # noqa: BLE001 - reported to the caller, never claimed as sent
        logger.warning("Trust & Safety email to %s failed: %s", to, exc)
        return False, f"email failed: {str(exc)[:120]}"
    return True, f"email sent to {to}"


# ─── Policies ────────────────────────────────────────────────────────────────

def policies(db: Session) -> list[dict]:
    ensure_schema()
    stored = {p.key: p for p in db.query(PlatformAupPolicy).all()}
    return [{"key": p["key"], "name": p["name"], "action": p["action"], "category": p["category"],
             "enabled": stored[p["key"]].enabled if p["key"] in stored else True,
             "queues": [QUEUE_LABELS[q] for q in p["queue"]], "escalates": bool(p.get("escalate")), "unsupported": p["unsupported"],
             "updated_by": stored[p["key"]].updated_by if p["key"] in stored else None} for p in POLICIES]


def set_policy(db: Session, key: str, enabled: bool, actor: str) -> tuple[bool, bool]:
    ensure_schema()
    if key not in POLICY_BY_KEY:
        raise TrustSafetyError("Unknown policy", 404)
    row = db.get(PlatformAupPolicy, key)
    old = row.enabled if row else True
    if row is None:
        row = PlatformAupPolicy(key=key)
        db.add(row)
    row.enabled, row.updated_by, row.updated_at = enabled, actor, datetime.utcnow()
    return old, enabled


# ─── Cases ───────────────────────────────────────────────────────────────────

def _event(db: Session, case: PlatformAbuseCase, event: str, actor: str, detail: Optional[dict] = None) -> None:
    db.add(PlatformCaseEvent(case_id=case.id, event=event[:300], actor=actor, detail=detail, created_at=datetime.utcnow()))


def _scope(query, column, allowed: Optional[list[int]]):
    return query if allowed is None else query.filter(column.in_(allowed or [0]))


def queue_approval(db: Session, action: str, tenant: Tenant, summary: str, payload: dict, requested_by: Optional[int]):
    """File an approval request (always reviewed, whatever the four-eyes setting). Reuses a pending one for the same action."""
    from app.models.tenant import PlatformApprovalRequest
    pending = db.query(PlatformApprovalRequest).filter(PlatformApprovalRequest.action == action, PlatformApprovalRequest.entity_type == "tenant",
                                                       PlatformApprovalRequest.entity_id == tenant.id, PlatformApprovalRequest.status == "pending").first()
    if pending:
        return pending, False
    row = PlatformApprovalRequest(action=action, module="tenants", entity_type="tenant", entity_id=tenant.id, entity_name=tenant.name,
                                  summary=summary[:500], payload=payload, status="pending", requested_by=requested_by)
    db.add(row)
    db.flush()
    return row, True


def create_case(db: Session, tenant: Optional[Tenant], title: str, category: str, severity: str, source: str, evidence: str,
                actor: str, admin_id: Optional[int]) -> PlatformAbuseCase:
    ensure_schema()
    title, source, evidence = title.strip(), source.strip(), (evidence or "").strip()
    if not title:
        raise TrustSafetyError("Describe what is being reported")
    if category not in CATEGORIES or severity not in SEVERITIES:
        raise TrustSafetyError("Unknown category or severity", 422)
    if not source:
        raise TrustSafetyError("Say where the report came from")
    now = datetime.utcnow()
    case = PlatformAbuseCase(ref=f"TMP-{now.timestamp()}", title=title[:300], category=category, severity=severity, status="Under review",
                             tenant_id=tenant.id if tenant else None, tenant_name=tenant.name if tenant else None, source=source[:120],
                             assigned_to=actor, legal_hold=True, opened_by=actor, opened_at=now)
    db.add(case)
    db.flush()
    case.ref = f"TS-{case.id:03d}"
    _event(db, case, "Case opened", source)
    if evidence:
        content = _canonical({"case": case.ref, "kind": "report_note", "text": evidence, "reported_by": actor, "at": now})
        db.add(PlatformCaseEvidence(case_id=case.id, tenant_id=case.tenant_id, kind="report_note", description="Report details",
                                    content=content, sha256=_hash(content), legal_hold=True, created_by=actor, created_at=now))
        _event(db, case, "Evidence preserved (hash locked)", "system", {"items": 1})
    policy = next((p for p in policies(db) if p["category"] == category), None)
    if policy and policy["enabled"] and tenant is not None:
        spec = POLICY_BY_KEY[policy["key"]]
        if spec.get("escalate"):
            case.status = "Escalated"
            _event(db, case, f"Escalated to legal (policy: {spec['name']})", "system")
        for action in spec["queue"]:
            summary = f"{QUEUE_LABELS[action]} '{tenant.name}' – {case.ref} ({spec['name']})"
            payload = {"tenant_id": tenant.id, "case_id": case.id, "reason": spec["name"], "policy": spec["key"]}
            row, created = queue_approval(db, action, tenant, summary, payload, admin_id)
            _event(db, case, f"Policy: {QUEUE_LABELS[action]} {'sent for approval' if created else 'already waiting for approval'} (request #{row.id})",
                   "system", {"approval_request": row.id})
        if spec["unsupported"]:
            _event(db, case, f"Policy: not automated – {spec['unsupported']}", "system")
    return case


def _evidence_counts(db: Session, case_ids: list[int]) -> dict[int, int]:
    if not case_ids:
        return {}
    return dict(db.query(PlatformCaseEvidence.case_id, func.count(PlatformCaseEvidence.id))
                .filter(PlatformCaseEvidence.case_id.in_(case_ids)).group_by(PlatformCaseEvidence.case_id).all())


def _case_row(c: PlatformAbuseCase, evidence: int) -> dict:
    return {"id": c.id, "ref": c.ref, "title": c.title, "category": c.category, "severity": c.severity, "status": c.status,
            "tenant_id": c.tenant_id, "tenant": c.tenant_name, "source": c.source, "opened_at": c.opened_at, "evidence": evidence,
            "assigned_to": c.assigned_to, "closed_at": c.closed_at}


def cases(db: Session, allowed: Optional[list[int]], status: str, offset: int, limit: int) -> dict:
    ensure_schema()
    q = _scope(db.query(PlatformAbuseCase), PlatformAbuseCase.tenant_id, allowed)
    if status == "open":
        q = q.filter(PlatformAbuseCase.status.in_(OPEN_STATUSES))
    elif status == "closed":
        q = q.filter(PlatformAbuseCase.status == "Closed")
    total = q.order_by(None).count()
    rows = q.order_by(PlatformAbuseCase.opened_at.desc(), PlatformAbuseCase.id.desc()).offset(offset).limit(limit).all()
    counts = _evidence_counts(db, [c.id for c in rows])
    return {"items": [_case_row(c, int(counts.get(c.id, 0))) for c in rows], "total": total, "offset": offset, "limit": limit}


def get_case(db: Session, case_id: int, allowed: Optional[list[int]]) -> PlatformAbuseCase:
    ensure_schema()
    case = db.get(PlatformAbuseCase, case_id)
    if case is None or (allowed is not None and case.tenant_id not in allowed):
        raise TrustSafetyError("Case not found", 404)
    return case


def case_detail(db: Session, case: PlatformAbuseCase) -> dict:
    events = db.query(PlatformCaseEvent).filter(PlatformCaseEvent.case_id == case.id).order_by(PlatformCaseEvent.created_at, PlatformCaseEvent.id).all()
    evidence = db.query(PlatformCaseEvidence).filter(PlatformCaseEvidence.case_id == case.id).order_by(PlatformCaseEvidence.id).all()
    jobs = {j.id: j for j in db.query(TenantExportJob).filter(TenantExportJob.id.in_([e.export_job_id for e in evidence if e.export_job_id] or [0])).all()}
    items = []
    for e in evidence:
        job = jobs.get(e.export_job_id) if e.export_job_id else None
        items.append({"id": e.id, "kind": e.kind, "description": e.description, "sha256": e.sha256 or (job.sha256 if job else None),
                      "legal_hold": e.legal_hold, "created_by": e.created_by, "created_at": e.created_at,
                      "export": {"id": job.id, "status": job.status, "error": job.error} if job else None})
    return {**_case_row(case, len(evidence)), "legal_hold": case.legal_hold,
            "timeline": [{"event": ev.event, "actor": ev.actor, "at": ev.created_at} for ev in events], "evidence_items": items}


CASE_ACTIONS = ("request_info", "warn", "escalate", "authority", "close")


def case_action(db: Session, case: PlatformAbuseCase, action: str, actor: str, note: str) -> str:
    if action not in CASE_ACTIONS:
        raise TrustSafetyError("Unknown action", 404)
    if case.status == "Closed":
        raise TrustSafetyError(f"{case.ref} is closed", 409)
    note = (note or "").strip()[:1000]
    tenant = db.get(Tenant, case.tenant_id) if case.tenant_id else None
    if action in ("request_info", "warn"):
        if tenant is None:
            raise TrustSafetyError("This case has no tenant to contact", 409)
        if action == "request_info":
            subject = f"Information requested – Trust & Safety case {case.ref}"
            body = (f"Hello {tenant.admin_name},\n\nThe platform Trust & Safety team is reviewing case {case.ref} concerning your workspace "
                    f"'{tenant.name}' ({case.category}).\n\n{note or 'Please reply with any information that helps us review it.'}\n")
        else:
            subject = f"Acceptable-use warning – case {case.ref}"
            body = (f"Hello {tenant.admin_name},\n\nActivity in your workspace '{tenant.name}' breaches the platform's acceptable-use policy "
                    f"({case.category}). Please stop it immediately; further breaches can lead to suspension.\n\n{note}\n")
        sent, outcome = send_mail(tenant.admin_email, subject, body)
        label = "Information requested from tenant admin" if action == "request_info" else "Warning sent to tenant admin"
        if not sent:
            label = ("Information request" if action == "request_info" else "Warning") + " not sent"
        _event(db, case, f"{label} ({outcome})", actor, {"note": note, "sent": sent})
        message = f"{label} – {outcome}"
    elif action == "escalate":
        case.status = "Escalated"
        _event(db, case, "Escalated to legal", actor, {"note": note})
        return "Escalated to legal"
    elif action == "authority":
        if not note:
            raise TrustSafetyError("Record which authority was notified and the reference", 422)
        _event(db, case, f"Authority notification logged: {note[:200]}", actor, {"note": note})
        message = "Authority notification logged"
    else:
        case.status, case.closed_at = "Closed", datetime.utcnow()
        _event(db, case, "Closed", actor, {"note": note})
        return "Case closed"
    if case.status == "Under review":
        case.status = "Investigating"
    return message


# ─── Users across tenants ────────────────────────────────────────────────────

def _tenant_user_rows(tenant: Tenant) -> list[dict]:
    session = get_tenant_session(tenant.slug)
    try:
        has_sessions = bool(_existing_tables(session, ["user_sessions"]))
        last = ("(SELECT MAX(s.last_active) FROM user_sessions s WHERE s.user_id = u.id)" if has_sessions else "NULL")
        rows = session.execute(text(f"SELECT u.id, u.full_name, u.email, u.role, u.is_active, u.last_login, {last} AS last_active "
                                    "FROM users u ORDER BY u.full_name")).mappings().all()
        return [dict(r) for r in rows]
    finally:
        session.close()


def all_users(db: Session, allowed: Optional[list[int]], q: str, offset: int, limit: int, tenant_id: Optional[int] = None) -> dict:
    """Users of every tenant in scope (one query per tenant database, in parallel). Terminated = an active platform user block."""
    ensure_schema()
    tenants = _scope(db.query(Tenant), Tenant.id, allowed)
    if tenant_id is not None:
        tenants = tenants.filter(Tenant.id == tenant_id)
    tenants = tenants.order_by(Tenant.name).all()
    blocks = {(b.tenant_id, b.value) for b in _scope(db.query(PlatformAccessBlock.tenant_id, PlatformAccessBlock.value)
                                                     .filter(PlatformAccessBlock.kind == "user", PlatformAccessBlock.active == True), PlatformAccessBlock.tenant_id, allowed).all()}  # noqa: E712
    unreachable, out = [], []
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(tenants)))) as pool:
        results = list(pool.map(lambda t: (t, _safe(_tenant_user_rows, t)), tenants))
    for tenant, rows in results:
        if rows is None:
            unreachable.append(tenant.name)
            continue
        mfa = (tenant.otp_mode or "never") != "never"
        for r in rows:
            status = "Terminated" if (tenant.id, str(r["id"])) in blocks else "Active" if r["is_active"] else "Suspended"
            out.append({"tenant_id": tenant.id, "tenant": tenant.name, "tenant_slug": tenant.slug, "id": r["id"], "name": r["full_name"],
                        "email": r["email"], "role": r["role"], "mfa": mfa, "last_active": r["last_active"] or r["last_login"], "status": status})
    suspended = sum(1 for u in out if u["status"] == "Suspended")
    if q:
        needle = q.lower()
        out = [u for u in out if needle in f"{u['name']} {u['email']} {u['tenant']} {u['role']}".lower()]
    return {"items": out[offset:offset + limit], "total": len(out), "offset": offset, "limit": limit, "suspended": suspended,
            "unreachable": unreachable}


def _safe(fn, *args):
    try:
        return fn(*args)
    except Exception:  # noqa: BLE001 - an unreachable tenant database is reported, not fatal
        logger.warning("Trust & Safety: tenant database unavailable", exc_info=True)
        return None


def _user(session, user_id: int):
    row = session.execute(text("SELECT id, full_name, email, username, role, is_active FROM users WHERE id = :id"), {"id": user_id}).mappings().first()
    if row is None:
        raise TrustSafetyError("User not found", 404)
    return row


def _revoke(session, user_id: int, reason: str) -> dict:
    """Sign the user out everywhere: sessions, trusted devices, quick-PIN and push tokens (the credentials the tenant app has)."""
    present = _existing_tables(session, ["user_sessions", "trusted_devices", "quick_pin_credentials", "user_push_tokens"])
    session.execute(text("UPDATE users SET force_logout_after = NOW() WHERE id = :id"), {"id": user_id})
    out = {"sessions": 0, "trusted_devices": 0, "quick_pins": 0, "push_tokens": 0, "api_keys": "none exist in the tenant app"}
    if "user_sessions" in present:
        out["sessions"] = session.execute(text(
            "UPDATE user_sessions SET is_active = 0, revoked_at = NOW(), revoke_reason = :r, revoke_scope = 'platform' "
            "WHERE user_id = :id AND is_active = 1 AND revoked_at IS NULL"), {"id": user_id, "r": reason[:255]}).rowcount
    for table, key in (("trusted_devices", "trusted_devices"), ("quick_pin_credentials", "quick_pins"), ("user_push_tokens", "push_tokens")):
        if table in present:
            out[key] = session.execute(text(f"UPDATE {table} SET is_active = 0 WHERE user_id = :id AND is_active = 1"), {"id": user_id}).rowcount
    return out


def _record(db: Session, action: str, tenant: Tenant, user_id: Optional[int], target: str, reason: Optional[str], actor: str,
            case: Optional[PlatformAbuseCase] = None, notes: Optional[str] = None, outcome: Optional[dict] = None) -> PlatformEnforcementAction:
    row = PlatformEnforcementAction(action=action, tenant_id=tenant.id, user_id=user_id, target=target[:400], reason=reason, actor=actor,
                                    case_id=case.id if case else None, notes=notes, outcome=outcome, created_at=datetime.utcnow())
    db.add(row)
    db.flush()
    return row


def set_user_active(db: Session, tenant: Tenant, user_id: int, active: bool, actor: str) -> dict:
    """Suspend (deactivate + revoke every credential) or reinstate a suspended user."""
    ensure_schema()
    session = get_tenant_session(tenant.slug)
    try:
        user = _user(session, user_id)
        if _active_user_block(db, tenant.id, user_id):
            raise TrustSafetyError(f"{user['full_name']} is terminated – use Restore", 409)
        if bool(user["is_active"]) == active:
            raise TrustSafetyError(f"{user['full_name']} is already {'active' if active else 'suspended'}", 409)
        session.execute(text("UPDATE users SET is_active = :a WHERE id = :id"), {"a": 1 if active else 0, "id": user_id})
        revoked = None if active else _revoke(session, user_id, "Suspended by platform Trust & Safety")
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
    action = "User reinstated" if active else "User suspended"
    _record(db, action, tenant, user_id, f"{user['email']} ({tenant.name})", "Review complete" if active else "Under investigation", actor,
            outcome={"revoked": revoked} if revoked else None)
    return {"name": user["full_name"], "email": user["email"], "action": action, "revoked": revoked}


def _active_user_block(db: Session, tenant_id: int, user_id: int) -> Optional[PlatformAccessBlock]:
    """User blocks are keyed by the tenant user's id (several accounts can share one email address)."""
    return db.query(PlatformAccessBlock).filter(PlatformAccessBlock.tenant_id == tenant_id, PlatformAccessBlock.active == True,  # noqa: E712
                                                PlatformAccessBlock.kind == "user", PlatformAccessBlock.value == str(user_id)).first()


def _snapshot(session, user_id: int, username: str) -> dict:
    """Evidence of the account as it was: profile (no secrets), sessions, sign-in attempts and trusted devices."""
    present = _existing_tables(session, ["user_sessions", "login_attempts", "trusted_devices"])
    user = dict(session.execute(text("SELECT * FROM users WHERE id = :id"), {"id": user_id}).mappings().first())
    secret = ("password", "pin", "token", "secret", "otp", "hash")
    profile = {k: v for k, v in user.items() if not any(s in k.lower() for s in secret)}
    snap = {"user": profile}
    if "user_sessions" in present:
        snap["sessions"] = [dict(r) for r in session.execute(text(
            "SELECT id, device, browser, os, ip_address, location, login_time, last_active, logout_time, revoked_at, is_active "
            "FROM user_sessions WHERE user_id = :id ORDER BY login_time DESC LIMIT 200"), {"id": user_id}).mappings()]
    if "login_attempts" in present:
        snap["sign_in_attempts"] = [dict(r) for r in session.execute(text(
            "SELECT ip_address, success, user_agent, created_at FROM login_attempts WHERE username = :u ORDER BY created_at DESC LIMIT 500"),
            {"u": username}).mappings()]
    if "trusted_devices" in present:
        snap["trusted_devices"] = [dict(r) for r in session.execute(text(
            "SELECT device_uuid, device_label, ip_address, trusted_at, last_used_at, is_active FROM trusted_devices WHERE user_id = :id"),
            {"id": user_id}).mappings()]
    return snap


def terminate_user(db: Session, tenant: Tenant, user_id: int, *, reason: str, case: Optional[PlatformAbuseCase], notes: str,
                   transfer_to: Optional[int], revoke: bool, notify: bool, block: bool, actor: str) -> dict:
    """Preserve evidence, hand over owned records, deactivate, revoke, block sign-in (platform blocklist) – one tenant transaction."""
    ensure_schema()
    if reason not in USER_REASONS:
        raise TrustSafetyError("Choose a reason", 422)
    session = get_tenant_session(tenant.slug)
    try:
        user = _user(session, user_id)
        email = (user["email"] or "").lower()
        if _active_user_block(db, tenant.id, user_id):
            raise TrustSafetyError(f"{user['full_name']} is already terminated", 409)
        domain = email.split("@")[-1] if "@" in email else ""
        if block:
            admin_domain = (tenant.admin_email or "").lower().split("@")[-1]
            if not domain:
                raise TrustSafetyError("This user has no email domain to block", 422)
            if domain == admin_domain:
                raise TrustSafetyError(f"Blocking {domain} would also block {tenant.name}'s own administrator – leave that option off", 409)
            others = session.execute(text("SELECT COUNT(*) FROM users WHERE id <> :id AND is_active = 1 AND LOWER(email) LIKE :d"),
                                     {"id": user_id, "d": f"%@{domain}"}).scalar()
            if others:
                raise TrustSafetyError(f"{others} other active user(s) in {tenant.name} use {domain} – blocking it would lock them out", 409)
        if transfer_to is not None:
            target = session.execute(text("SELECT id, full_name, is_active FROM users WHERE id = :id"), {"id": transfer_to}).mappings().first()
            if target is None or transfer_to == user_id or not target["is_active"]:
                raise TrustSafetyError("Records can only be transferred to another active user of the same tenant", 422)
        # 1. Evidence first: nothing below runs unless it is stored and hashed.
        snap = _snapshot(session, user_id, user["username"])
        content = _canonical({"kind": "user_snapshot", "tenant": tenant.slug, "user_id": user_id, "taken_at": datetime.utcnow(), "data": snap})
        evidence = PlatformCaseEvidence(case_id=case.id if case else None, tenant_id=tenant.id, kind="user_snapshot",
                                        description=f"Account snapshot of {user['email']} before termination", content=content,
                                        sha256=_hash(content), legal_hold=True, created_by=actor, created_at=datetime.utcnow())
        db.add(evidence)
        db.flush()
        devices = [d["device_uuid"] for d in snap.get("trusted_devices", []) if d.get("device_uuid")]
        # 2. Tenant database: hand over records, deactivate, revoke.
        transferred = {}
        if transfer_to is not None:
            for table in sorted(_existing_tables(session, list(OWNED_RECORDS))):
                transferred[table] = session.execute(text(f"UPDATE {table} SET assigned_to = :to WHERE assigned_to = :id"),
                                                     {"to": transfer_to, "id": user_id}).rowcount
        session.execute(text("UPDATE users SET is_active = 0 WHERE id = :id"), {"id": user_id})
        revoked = _revoke(session, user_id, f"Terminated by platform Trust & Safety: {reason}") if revoke else None
        session.commit()
    except Exception:
        session.rollback()
        db.rollback()
        raise
    finally:
        session.close()
    # 3. Platform blocklist (checked by every tenant sign-in path), history, case timeline.
    enforcement = _record(db, "User terminated", tenant, user_id, f"{user['email']} ({tenant.name})", reason, actor, case, notes.strip()[:2000] or None)
    evidence.enforcement_id = enforcement.id
    blocks = [("user", str(user_id))] + ([("domain", domain)] + [("device", d) for d in devices] if block else [])
    for kind, value in blocks:
        db.add(PlatformAccessBlock(tenant_id=tenant.id, kind=kind, value=value[:255], enforcement_id=enforcement.id, active=True,
                                   created_by=actor, created_at=datetime.utcnow()))
    outcome = {"evidence_id": evidence.id, "evidence_sha256": evidence.sha256, "revoked": revoked, "transferred": transferred,
               "blocked": {"domain": domain if block else None, "devices": len(devices) if block else 0}}
    if case is not None:
        _event(db, case, f"User terminated: {user['email']}", actor, {"enforcement_id": enforcement.id, "evidence_id": evidence.id})
    db.flush()
    if notify:
        sent, what = send_mail(tenant.admin_email, f"A user in {tenant.name} was terminated",
                               f"Hello {tenant.admin_name},\n\nThe platform Trust & Safety team terminated {user['full_name']} ({user['email']}) "
                               f"in '{tenant.name}'. Reason: {reason}.\nTheir records stay with your workspace"
                               f"{' and were handed over' if transferred else ''}. Evidence is preserved under legal hold.\n")
        outcome["notified"] = {"sent": sent, "detail": what}
    enforcement.outcome = outcome
    return {"name": user["full_name"], "email": user["email"], **outcome}


def restore_user(db: Session, tenant: Tenant, user_id: int, actor: str) -> dict:
    """Lift a termination: platform blocks from it are lifted and the account is re-activated (credentials stay revoked)."""
    ensure_schema()
    session = get_tenant_session(tenant.slug)
    try:
        user = _user(session, user_id)
        block = _active_user_block(db, tenant.id, user_id)
        if block is None:
            raise TrustSafetyError(f"{user['full_name']} is not terminated", 409)
        session.execute(text("UPDATE users SET is_active = 1 WHERE id = :id"), {"id": user_id})
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
    now = datetime.utcnow()
    lifted = db.query(PlatformAccessBlock).filter(PlatformAccessBlock.active == True, PlatformAccessBlock.tenant_id == tenant.id,  # noqa: E712
                                                  ((PlatformAccessBlock.enforcement_id == block.enforcement_id) & PlatformAccessBlock.enforcement_id.isnot(None))
                                                  | (PlatformAccessBlock.id == block.id)).all()
    for b in lifted:
        b.active, b.lifted_at = False, now
    _record(db, "User restored", tenant, user_id, f"{user['email']} ({tenant.name})", "Review complete", actor,
            outcome={"blocks_lifted": len(lifted)})
    return {"name": user["full_name"], "email": user["email"], "blocks_lifted": len(lifted)}


def blocked_sign_in(master_db: Session, tenant_id: int, user_id: Optional[int], email: Optional[str], device_uuid: Optional[str]) -> Optional[str]:
    """Tenant sign-in check: why this sign-in is blocked by the platform, or None. One indexed query."""
    if not _ready.get("schema"):
        try:
            ensure_schema()
        except Exception:  # noqa: BLE001 - never stop tenant sign-in because the platform table can't be created
            logger.exception("Trust & Safety blocklist unavailable")
            return None
    email = (email or "").strip().lower()
    candidates = [("user", str(user_id))] if user_id is not None else []
    if "@" in email:
        candidates.append(("domain", email.split("@")[-1]))
    if device_uuid:
        candidates.append(("device", hash_device_uuid(device_uuid)))
    if not candidates:
        return None
    clauses = " OR ".join(f"(kind = :k{i} AND value = :v{i})" for i in range(len(candidates)))
    params = {"t": tenant_id, **{f"k{i}": k for i, (k, _) in enumerate(candidates)}, **{f"v{i}": v for i, (_, v) in enumerate(candidates)}}
    kind = master_db.execute(text(f"SELECT kind FROM platform_access_blocks WHERE tenant_id = :t AND active = 1 AND ({clauses}) LIMIT 1"), params).scalar()
    return kind


# ─── Tenant enforcement ──────────────────────────────────────────────────────

def tenant_enforce(db: Session, tenant: Tenant, action: str, reason: str, case: Optional[PlatformAbuseCase], actor: str,
                   base_url: Optional[str] = None) -> dict:
    """Suspend (reversible) or terminate: legal-hold export + suspension + deletion scheduled after the grace period.

    Nothing deletes tenant data: the platform has no automatic deletion, and the legal-hold export is exempt from expiry."""
    ensure_schema()
    from app.services import tenant_data_transfer as transfer
    if action not in ("suspend", "terminate"):
        raise TrustSafetyError("Unknown action", 422)
    if reason not in TENANT_REASONS:
        raise TrustSafetyError("Choose a reason", 422)
    now = datetime.utcnow()
    old = {"status": tenant.status, "deletion_scheduled_at": tenant.deletion_scheduled_at}
    if action == "suspend":
        if tenant.status == "suspended":
            raise TrustSafetyError(f"{tenant.name} is already suspended", 409)
        tenant.status = "suspended"
        row = _record(db, "Tenant suspended", tenant, None, tenant.name, reason, actor, case, outcome={"previous_status": old["status"]})
        if case is not None:
            _event(db, case, "Tenant suspended", actor, {"enforcement_id": row.id})
        return {"action": "Tenant suspended", "message": f"{tenant.name} suspended", "old": old}
    if tenant.deletion_scheduled_at is not None:
        raise TrustSafetyError(f"{tenant.name} is already scheduled for deletion", 409)
    unavailable = transfer.option_status()
    encryption = transfer.ENCRYPTIONS[0] if not unavailable.get(transfer.ENCRYPTIONS[0]) else "None"
    job = TenantExportJob(tenant_id=tenant.id, components=[k for k, _ in transfer.EXPORT_COMPONENTS], format="SQL dump (MariaDB) + files",
                          pii="Include", encryption=encryption, delivery="Secure download link", link_days=30, status="queued",
                          options={"attempts": 1, "legal_hold": True, "case": case.ref if case else None, "reason": reason},
                          base_url=base_url, requested_by=actor)
    db.add(job)
    db.flush()
    evidence = PlatformCaseEvidence(case_id=case.id if case else None, tenant_id=tenant.id, kind="tenant_export",
                                    description=f"Legal-hold export EXP-{job.id} of {tenant.name} (complete database and files)",
                                    export_job_id=job.id, legal_hold=True, created_by=actor, created_at=now)
    db.add(evidence)
    tenant.status = "suspended"
    tenant.deletion_scheduled_at = now + timedelta(days=GRACE_DAYS)
    row = _record(db, "Tenant terminated", tenant, None, tenant.name, reason, actor, case,
                  outcome={"export_job": job.id, "deletion_scheduled_at": tenant.deletion_scheduled_at.isoformat(), "previous_status": old["status"]})
    db.flush()
    evidence.enforcement_id = row.id
    if case is not None:
        _event(db, case, f"Tenant terminated – legal-hold export EXP-{job.id} started; deletion scheduled for {tenant.deletion_scheduled_at:%d %b %Y}",
               actor, {"enforcement_id": row.id, "export_job": job.id})
    return {"action": "Tenant terminated", "export_job": job.id, "deletion_scheduled_at": tenant.deletion_scheduled_at, "old": old,
            "message": f"{tenant.name} suspended and scheduled for deletion on {tenant.deletion_scheduled_at:%d %b %Y} – legal-hold export EXP-{job.id} started"}


def warn_tenant(db: Session, tenant: Tenant, case: Optional[PlatformAbuseCase], reason: str, actor: str) -> dict:
    """Approved policy action for data scraping: email the tenant admin, recorded on the case."""
    if case is not None and case.status != "Closed":
        message = case_action(db, case, "warn", actor, f"Policy: {reason}")
        return {"message": message}
    sent, what = send_mail(tenant.admin_email, "Acceptable-use warning", f"Hello {tenant.admin_name},\n\nActivity in '{tenant.name}' breaches the "
                                                                          f"platform's acceptable-use policy ({reason}).\n")
    return {"message": f"Warning {'sent' if sent else 'not sent'} – {what}"}


# ─── Overview ────────────────────────────────────────────────────────────────

def kpis(db: Session, allowed: Optional[list[int]], users_suspended: Optional[int]) -> dict:
    ensure_schema()
    base = _scope(db.query(PlatformAbuseCase), PlatformAbuseCase.tenant_id, allowed)
    counts = dict(_scope(db.query(PlatformAbuseCase.severity, func.count(PlatformAbuseCase.id)).filter(PlatformAbuseCase.status.in_(OPEN_STATUSES)),
                         PlatformAbuseCase.tenant_id, allowed).group_by(PlatformAbuseCase.severity).all())
    terminated = _scope(db.query(func.count(PlatformEnforcementAction.id)).filter(PlatformEnforcementAction.action == "User terminated",
                                                                                 PlatformEnforcementAction.created_at >= datetime.utcnow() - timedelta(days=90)),
                        PlatformEnforcementAction.tenant_id, allowed).scalar()
    tenants_suspended = _scope(db.query(func.count(Tenant.id)).filter(Tenant.status == "suspended"), Tenant.id, allowed).scalar()
    avg = base.filter(PlatformAbuseCase.status == "Closed", PlatformAbuseCase.closed_at.isnot(None)) \
        .with_entities(func.avg(func.timestampdiff(text("SECOND"), PlatformAbuseCase.opened_at, PlatformAbuseCase.closed_at))).scalar()
    return {"open": int(sum(counts.values())), "critical": int(counts.get("Critical", 0)), "users_terminated_90d": int(terminated or 0),
            "users_suspended": users_suspended, "tenants_suspended": int(tenants_suspended or 0),
            "avg_resolution_days": round(float(avg) / 86400, 1) if avg is not None else None}


def history(db: Session, allowed: Optional[list[int]], offset: int, limit: int) -> dict:
    ensure_schema()
    q = _scope(db.query(PlatformEnforcementAction), PlatformEnforcementAction.tenant_id, allowed)
    total = q.order_by(None).count()
    rows = q.order_by(PlatformEnforcementAction.created_at.desc(), PlatformEnforcementAction.id.desc()).offset(offset).limit(limit).all()
    return {"items": [{"id": r.id, "at": r.created_at, "action": r.action, "target": r.target, "reason": r.reason, "by": r.actor,
                       "case_id": r.case_id} for r in rows], "total": total, "offset": offset, "limit": limit}
