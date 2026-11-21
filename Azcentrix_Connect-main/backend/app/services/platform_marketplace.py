"""Marketplace (Mobile & ecosystem): app registry, review, policy, plan access and tenant installs.

* Publishers submit apps through the publisher API (key ``azp_…``, stored as an HMAC). Every app starts "In review".
* Security: at submission the platform reviews the requested scopes (deterministic rules – not a code scan). A code scan
  can only come from an external scanner posting signed results (MARKETPLACE_SCANNER_SECRET); none is connected by
  default. The stricter of the two results is shown. Critical apps are never approved; with "Require security scan
  before listing" on, an app without a code-scan result can't be approved; with "Auto-suspend apps with critical
  findings" on, a Critical scan result suspends a Live app.
* Tenant admins install Live apps through the tenant API, within their plan's marketplace access, accepting exactly
  the scopes the app requests. Paid apps need "Allow paid apps"; there is no billing of app charges yet, so the revenue
  share is not reported.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
from datetime import datetime
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.database import master_engine
from app.models.platform_marketplace import (PlatformMarketApp, PlatformMarketInstall, PlatformMarketPlanAccess, PlatformMarketPublisher,
                                             PlatformMarketSetting)
from app.models.tenant import Plan, Tenant

RESOURCES = ("orders", "invoices", "tenders", "bids", "documents", "location", "leads", "customers", "quotations", "messages", "all")
SCOPE = re.compile(r"^(read|write|send):([a-z_]+)$")
CATEGORIES = ("Accounting", "Tender sources", "Messaging", "Analytics", "Documents", "Mobile", "Intelligence", "Migration", "Productivity", "Other")
POLICY = [
    ("scan_required", "Require security scan before listing", True),
    ("show_scopes", "Show requested scopes to tenant admins", True),
    ("private_apps", "Allow private (tenant-only) apps", True),
    ("paid_apps", "Allow paid apps (20% revenue share)", False),
    ("auto_suspend", "Auto-suspend apps with critical findings", True),
]
ACCESS_LABEL = {"browse": "Browse only", "limited": "Install up to {n} apps", "unlimited": "Unlimited + private apps"}
# Agreed starting access for this deployment's plans; other plans start at "browse" until set.
PLAN_ACCESS = {"core": ("browse", None), "standard": ("limited", 5), "test": ("limited", 5), "premium": ("unlimited", None), "enterprise": ("unlimited", None)}
RANK = {"clean": 0, "findings": 1, "critical": 2}
_ready: dict[str, bool] = {}


def ensure_schema() -> bool:
    if _ready.get("schema"):
        return False
    for model in (PlatformMarketPublisher, PlatformMarketApp, PlatformMarketInstall, PlatformMarketPlanAccess, PlatformMarketSetting):
        model.__table__.create(bind=master_engine, checkfirst=True)
    _ready["schema"] = True
    return True


class MarketError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _hmac(raw: str) -> str:
    return hmac.new(app_settings.SECRET_KEY.encode(), raw.encode(), hashlib.sha256).hexdigest()


# ─── Policy & plans ──────────────────────────────────────────────────────────

def policy(db: Session) -> dict[str, bool]:
    ensure_schema()
    stored = {r.key: r.enabled for r in db.query(PlatformMarketSetting).all()}
    return {k: stored.get(k, d) for k, _, d in POLICY}


def set_policy(db: Session, key: str, enabled: bool, actor: str) -> tuple[bool, bool]:
    if key not in {k for k, _, _ in POLICY}:
        raise MarketError("Unknown policy", 404)
    old = policy(db)[key]
    row = db.get(PlatformMarketSetting, key)
    if row is None:
        row = PlatformMarketSetting(key=key)
        db.add(row)
    row.enabled, row.updated_by, row.updated_at = enabled, actor, datetime.utcnow()
    return old, enabled


def plan_access(db: Session) -> list[dict]:
    """Every active plan with its marketplace access (stored once from the agreed mapping)."""
    ensure_schema()
    plans = db.query(Plan).filter(Plan.is_active == True).order_by(Plan.price_monthly, Plan.id).all()  # noqa: E712
    stored = {r.plan_id: r for r in db.query(PlatformMarketPlanAccess).filter(PlatformMarketPlanAccess.plan_id.in_([p.id for p in plans] or [0])).all()}
    out = []
    for p in plans:
        row = stored.get(p.id)
        if row is None:
            access, n = PLAN_ACCESS.get(p.slug, ("browse", None))
            row = PlatformMarketPlanAccess(plan_id=p.id, access=access, max_installs=n, updated_by="default (agreed mapping)")
            db.add(row)
        out.append({"plan_id": p.id, "plan": p.name, "access": row.access, "max_installs": row.max_installs,
                    "label": ACCESS_LABEL[row.access].format(n=row.max_installs)})
    db.flush()
    return out


def tenant_access(db: Session, tenant: Tenant) -> dict:
    row = db.get(PlatformMarketPlanAccess, tenant.plan_id) if tenant.plan_id else None
    if row is None:
        plan_access(db)
        row = db.get(PlatformMarketPlanAccess, tenant.plan_id) if tenant.plan_id else None
    return {"access": row.access if row else "browse", "max_installs": row.max_installs if row else None}


# ─── Scopes & security ───────────────────────────────────────────────────────

def validate_scopes(scopes) -> list[str]:
    if not isinstance(scopes, list) or not scopes or len(scopes) > 20:
        raise MarketError("List the scopes the app needs (1–20)", 422)
    out = []
    for s in scopes:
        m = SCOPE.match(str(s).strip())
        if not m or m.group(2) not in RESOURCES or (m.group(1) == "send" and m.group(2) != "messages"):
            raise MarketError(f"Unknown scope “{s}”", 422)
        out.append(m.group(0))
    return sorted(set(out))


def review_scopes(scopes: list[str]) -> tuple[str, list[str]]:
    """The platform's scope review (rules on what the app asks for – not an inspection of its code)."""
    findings = []
    if "write:all" in scopes:
        return "critical", ["Requests write access to all data"]
    writes = [s for s in scopes if s.startswith("write:")]
    if "read:all" in scopes and writes:
        findings.append("Reads all data and can also write")
    if "write:bids" in scopes:
        findings.append("Can change bid / pricing data")
    return ("findings" if findings else "clean"), findings


def security(app: PlatformMarketApp) -> dict:
    """Effective security status: the stricter of the scope review and the external code scan."""
    scan = app.scan_result
    worst = max((r for r in (app.scope_review, scan) if r), key=lambda r: RANK[r])
    n = len(app.scope_findings or []) + (app.scan_findings or 0 if scan == "findings" else 0)
    label = "Critical" if worst == "critical" else f"{n} finding{'s' if n != 1 else ''}" if worst == "findings" else "Clean" if scan else "Not scanned"
    return {"label": label, "level": worst if scan or worst != "clean" else "unscanned", "code_scanned": scan is not None,
            "scope_review": app.scope_review, "scope_findings": app.scope_findings or [], "scan_result": scan, "scanned_at": app.scanned_at}


# ─── Status transitions ──────────────────────────────────────────────────────

TRANSITIONS = {"approve": ("In review",), "reject": ("In review",), "suspend": ("Live",), "reinstate": ("Suspended", "Rejected")}


def _approvable(db: Session, app: PlatformMarketApp) -> None:
    pol = policy(db)
    sec = security(app)
    if sec["level"] == "critical":
        raise MarketError(f"{app.name} has critical security findings – it can't be listed", 409)
    if pol["scan_required"] and not sec["code_scanned"]:
        raise MarketError(f"{app.name} has no security scan result – connect a scanner or switch off “Require security scan before listing”", 409)
    if app.price_monthly and not pol["paid_apps"]:
        raise MarketError(f"{app.name} is a paid app and paid apps are not allowed", 409)
    if app.private_tenant_id and not pol["private_apps"]:
        raise MarketError(f"{app.name} is a private app and private apps are not allowed", 409)


def change_status(db: Session, app: PlatformMarketApp, action: str, reason: str, actor: str) -> tuple[str, str]:
    if action not in TRANSITIONS:
        raise MarketError("Unknown action", 404)
    if app.status not in TRANSITIONS[action]:
        raise MarketError(f"{app.name} is {app.status} – it can't be {action}d", 409)
    if action in ("approve", "reinstate"):
        _approvable(db, app)
    old = app.status
    app.status = {"approve": "Live", "reject": "Rejected", "suspend": "Suspended", "reinstate": "Live"}[action]
    app.status_reason, app.status_by, app.status_at = (reason or "").strip()[:300] or None, actor, datetime.utcnow()
    return old, app.status


# ─── Publishers & submissions ────────────────────────────────────────────────

def create_publisher(db: Session, name: str, email: str, actor: str) -> tuple[PlatformMarketPublisher, str]:
    ensure_schema()
    name = (name or "").strip()
    if not name:
        raise MarketError("Name the publisher", 422)
    if db.query(PlatformMarketPublisher.id).filter(func.lower(PlatformMarketPublisher.name) == name.lower()).first():
        raise MarketError("A publisher with this name exists", 409)
    raw = "azp_" + secrets.token_urlsafe(32)
    row = PlatformMarketPublisher(name=name[:200], contact_email=(email or "").strip()[:200] or None, key_prefix=raw[:14], key_hash=_hmac(raw),
                                  created_by=actor, created_at=datetime.utcnow())
    db.add(row)
    db.flush()
    return row, raw


def publisher_for(db: Session, raw: Optional[str]) -> Optional[PlatformMarketPublisher]:
    ensure_schema()
    if not raw or not raw.startswith("azp_"):
        return None
    row = db.query(PlatformMarketPublisher).filter(PlatformMarketPublisher.key_prefix == raw[:14]).first()
    return row if row and hmac.compare_digest(row.key_hash, _hmac(raw)) else None


def submit_app(db: Session, publisher: PlatformMarketPublisher, name: str, category: str, scopes, price, private_tenant_slug: Optional[str]) -> PlatformMarketApp:
    name = (name or "").strip()
    if not name or len(name) > 150:
        raise MarketError("App name must be 1–150 characters", 422)
    if category not in CATEGORIES:
        raise MarketError(f"Category must be one of: {', '.join(CATEGORIES)}", 422)
    scopes = validate_scopes(scopes)
    try:
        price = int(price or 0)
    except (TypeError, ValueError):
        raise MarketError("Price must be whole rupees", 422)
    if price < 0 or price > 1_000_000:
        raise MarketError("Price out of range", 422)
    pol = policy(db)
    if price and not pol["paid_apps"]:
        raise MarketError("Paid apps are not allowed on this marketplace", 409)
    tenant = None
    if private_tenant_slug:
        if not pol["private_apps"]:
            raise MarketError("Private apps are not allowed on this marketplace", 409)
        tenant = db.query(Tenant).filter(Tenant.slug == private_tenant_slug).first()
        if tenant is None:
            raise MarketError("Tenant for the private app not found", 404)
    if db.query(PlatformMarketApp.id).filter(PlatformMarketApp.publisher_id == publisher.id, PlatformMarketApp.name == name).first():
        raise MarketError("You already submitted an app with this name", 409)
    review, findings = review_scopes(scopes)
    app = PlatformMarketApp(publisher_id=publisher.id, name=name, category=category, scopes=scopes, price_monthly=price,
                            private_tenant_id=tenant.id if tenant else None, scope_review=review, scope_findings=findings or None,
                            status="In review", created_at=datetime.utcnow())
    db.add(app)
    db.flush()
    return app


# ─── External scanner ────────────────────────────────────────────────────────

def scanner_secret() -> Optional[str]:
    return os.environ.get("MARKETPLACE_SCANNER_SECRET") or getattr(app_settings, "MARKETPLACE_SCANNER_SECRET", None) or None


def verify_scanner(body: bytes, signature: Optional[str]) -> None:
    secret = scanner_secret()
    if not secret:
        raise MarketError("No security scanner is connected (MARKETPLACE_SCANNER_SECRET is not set)", 503)
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    if not signature or not hmac.compare_digest(expected, signature.replace("sha256=", "")):
        raise MarketError("Invalid scanner signature", 401)


def record_scan(db: Session, app: PlatformMarketApp, result: str, findings: int) -> Optional[str]:
    """Store a code-scan result; returns the status change it caused (auto-suspend), if any."""
    if result not in RANK:
        raise MarketError("result must be clean, findings or critical", 422)
    app.scan_result, app.scan_findings, app.scanned_at = result, max(0, int(findings or 0)), datetime.utcnow()
    if result == "critical" and app.status == "Live" and policy(db)["auto_suspend"]:
        app.status, app.status_reason, app.status_by, app.status_at = "Suspended", "Critical security scan result (auto-suspended)", "security scanner", datetime.utcnow()
        return "Suspended"
    return None


# ─── Tenant installs ─────────────────────────────────────────────────────────

def visible_apps(db: Session, tenant: Tenant) -> list[dict]:
    pol, acc = policy(db), tenant_access(db, tenant)
    q = db.query(PlatformMarketApp, PlatformMarketPublisher.name).join(PlatformMarketPublisher, PlatformMarketPublisher.id == PlatformMarketApp.publisher_id) \
        .filter(PlatformMarketApp.status == "Live")
    rows = [(a, p) for a, p in q.all() if a.private_tenant_id in (None, tenant.id) and (a.private_tenant_id is None or (acc["access"] == "unlimited" and pol["private_apps"]))]
    installed = {i.app_id for i in db.query(PlatformMarketInstall.app_id).filter(PlatformMarketInstall.tenant_id == tenant.id, PlatformMarketInstall.active == True).all()}  # noqa: E712
    return [{"id": a.id, "name": a.name, "publisher": p, "category": a.category, "price_monthly": a.price_monthly, "private": a.private_tenant_id is not None,
             "scopes": a.scopes if pol["show_scopes"] else None, "security": security(a)["label"], "installed": a.id in installed} for a, p in rows]


def install(db: Session, tenant: Tenant, app: PlatformMarketApp, accepted_scopes, user_id: Optional[int]) -> PlatformMarketInstall:
    pol, acc = policy(db), tenant_access(db, tenant)
    if app.status != "Live":
        raise MarketError("This app is not available", 404)
    if app.private_tenant_id not in (None, tenant.id):
        raise MarketError("This app is not available", 404)
    if acc["access"] == "browse":
        raise MarketError("Your plan can browse the marketplace but not install apps", 403)
    if app.private_tenant_id and (acc["access"] != "unlimited" or not pol["private_apps"]):
        raise MarketError("Private apps need a plan with private-app access", 403)
    if app.price_monthly and not pol["paid_apps"]:
        raise MarketError("Paid apps are not available", 409)
    try:
        accepted = validate_scopes(accepted_scopes)
    except MarketError:
        raise MarketError("Accept the scopes the app requests", 422)
    if accepted != sorted(app.scopes):
        raise MarketError(f"The app requests {', '.join(app.scopes)} – accept exactly these scopes to install", 422)
    row = db.query(PlatformMarketInstall).filter(PlatformMarketInstall.app_id == app.id, PlatformMarketInstall.tenant_id == tenant.id).with_for_update().first()
    if row is not None and row.active:
        raise MarketError("Already installed", 409)
    if acc["access"] == "limited":
        active = db.query(func.count(PlatformMarketInstall.id)).filter(PlatformMarketInstall.tenant_id == tenant.id, PlatformMarketInstall.active == True).scalar()  # noqa: E712
        if active >= (acc["max_installs"] or 0):
            raise MarketError(f"Your plan allows {acc['max_installs']} installed apps – uninstall one first", 409)
    if row is None:
        row = PlatformMarketInstall(app_id=app.id, tenant_id=tenant.id)
        db.add(row)
    row.active, row.scopes_granted, row.installed_by_user, row.installed_at, row.uninstalled_at = True, accepted, user_id, datetime.utcnow(), None
    db.flush()
    return row


def uninstall(db: Session, tenant: Tenant, app_id: int) -> None:
    row = db.query(PlatformMarketInstall).filter(PlatformMarketInstall.app_id == app_id, PlatformMarketInstall.tenant_id == tenant.id, PlatformMarketInstall.active == True).first()  # noqa: E712
    if row is None:
        raise MarketError("Not installed", 404)
    row.active, row.uninstalled_at = False, datetime.utcnow()


# ─── Platform overview ───────────────────────────────────────────────────────

def kpis(db: Session) -> dict:
    ensure_schema()
    counts = dict(db.query(PlatformMarketApp.status, func.count(PlatformMarketApp.id)).group_by(PlatformMarketApp.status).all())
    installs = db.query(func.count(PlatformMarketInstall.id)).filter(PlatformMarketInstall.active == True).scalar()  # noqa: E712
    return {"live": int(counts.get("Live", 0)), "in_review": int(counts.get("In review", 0)), "installs": int(installs or 0),
            "suspended": int(counts.get("Suspended", 0)), "revenue_share_30d": None}


def apps_page(db: Session, q: str, offset: int, limit: int) -> dict:
    """One page of apps with publisher (join) and active install counts (one grouped query for the page)."""
    ensure_schema()
    base = db.query(PlatformMarketApp, PlatformMarketPublisher.name).join(PlatformMarketPublisher, PlatformMarketPublisher.id == PlatformMarketApp.publisher_id)
    if q:
        like = f"%{q.lower()}%"
        base = base.filter(func.lower(func.concat_ws(" ", PlatformMarketApp.name, PlatformMarketPublisher.name, PlatformMarketApp.category, PlatformMarketApp.status)).like(like))
    total = base.order_by(None).count()
    rows = base.order_by(PlatformMarketApp.created_at.desc(), PlatformMarketApp.id.desc()).offset(offset).limit(limit).all()
    ids = [a.id for a, _ in rows]
    counts = dict(db.query(PlatformMarketInstall.app_id, func.count(PlatformMarketInstall.id))
                  .filter(PlatformMarketInstall.app_id.in_(ids or [0]), PlatformMarketInstall.active == True).group_by(PlatformMarketInstall.app_id).all())  # noqa: E712
    return {"items": [{"id": a.id, "name": a.name, "publisher": p, "category": a.category, "installs": int(counts.get(a.id, 0)), "rating": None,
                       "scopes": a.scopes, "security": security(a), "status": a.status, "status_reason": a.status_reason, "price_monthly": a.price_monthly,
                       "private": a.private_tenant_id is not None} for a, p in rows],
            "total": total, "offset": offset, "limit": limit}
