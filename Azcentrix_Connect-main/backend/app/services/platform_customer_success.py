"""Customer success (Command → Customer Success).

Health = weighted mean of five factors, each 0–100, from measured data only:

* Product usage (30 %) – share of active seats with a sign-in session in the last 30 days (Usage Monitoring counts).
* Module adoption (25 %) – mean over the tenant's entitled modules of the share of active seats that used the module in the
  last 30 days (records created / owned, mobile-app sessions). Feature adoption heat-map shows the same figures.
* Support experience (15 %) – share of Support Desk tickets from the last 90 days resolved within the resolution target
  (the ticket's SLA resolution deadline from SLA & CSAT; tickets without one use Critical / High 1 day, Medium 3 days,
  Low 5 days); an open ticket past its target counts as missed, one within it isn't counted.
* Billing health (15 %) – share of invoices due in the last 12 months paid by their due date. Not billed (trial / free /
  cancelled, or nothing due) → unavailable.
* Customer sentiment (NPS, 15 %) – no survey data is collected, so always unavailable.

Missing factors are left out and the rest re-weighted, but only when the measured factors carry at least 55 % of the
weight; otherwise the tenant is "Not scored". Churn risk: High < 65 ≤ Medium < 78 ≤ Low.

Tenant-database figures are cached for 5 minutes (Run playbook re-reads them).
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.database import get_tenant_session, master_engine
from app.models.platform_customer_success import PlatformCsAction, PlatformCsCondition, PlatformCsPlaybook, PlatformCsRun, PlatformCsTask
from app.models.tenant import Feature, PlanFeature, SuperAdmin, Tenant, TenantFeature
from app.services import platform_access as pa
from app.services import platform_billing as billing
from app.services import platform_usage as usage

logger = logging.getLogger(__name__)

WEIGHTS = [("usage", "Product usage", 30), ("adoption", "Module adoption", 25), ("support", "Support experience", 15),
           ("billing", "Billing health", 15), ("nps", "Customer sentiment (NPS)", 15)]
MIN_WEIGHT = 55
TARGET_DAYS = {"Critical": 1, "High": 1, "Medium": 3, "Low": 5}
# Heat-map modules: label, entitlement feature key (None = mobile app switch), tenant-database count of distinct active users.
MODULES = [
    ("Lead", "leads.view", "leads", "SELECT COUNT(DISTINCT created_by) FROM leads WHERE created_at >= :since AND created_by IN (SELECT id FROM users WHERE is_active = 1)"),
    ("Deal", "opportunities.view", "leads", "SELECT COUNT(DISTINCT COALESCE(assigned_to, created_by)) FROM leads WHERE opportunity_created_at >= :since "
                                            "AND COALESCE(assigned_to, created_by) IN (SELECT id FROM users WHERE is_active = 1)"),
    ("Bid", "tenders.view", "tenders", "SELECT COUNT(DISTINCT created_by) FROM tenders WHERE created_at >= :since AND created_by IN (SELECT id FROM users WHERE is_active = 1)"),
    ("Quote", "quotations.view", "quotations", "SELECT COUNT(DISTINCT created_by) FROM quotations WHERE created_at >= :since AND created_by IN (SELECT id FROM users WHERE is_active = 1)"),
    ("EMD", "emdbg.view", "emdbg", "SELECT COUNT(DISTINCT created_by) FROM emdbg WHERE created_at >= :since AND created_by IN (SELECT id FROM users WHERE is_active = 1)"),
    ("KAM", "kam.view", "kam_activities", "SELECT COUNT(DISTINCT user_id) FROM kam_activities WHERE created_at >= :since AND user_id IN (SELECT id FROM users WHERE is_active = 1)"),
    ("Appr", "approvals.view", "approval_requests", "SELECT COUNT(DISTINCT requester_user_id) FROM approval_requests WHERE created_at >= :since "
                                                    "AND requester_user_id IN (SELECT id FROM users WHERE is_active = 1)"),
    ("Mob", None, "user_sessions", "SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE device LIKE 'Dart/%' AND COALESCE(logout_time, last_active) >= :since "
                                   "AND user_id IN (SELECT id FROM users WHERE is_active = 1)"),   # the Flutter app's sessions
]
WORKFLOW_TABLES = {"workflow_definitions": "applied_at", "approval_workflows": "updated_at", "approval_rules": "created_at"}
PLAYBOOKS = [
    ("health_low", "Health drops below 65", "Assign CSM · schedule call · offer training"),
    ("no_signin", "No sign-in for 14 days", "Email admin · in-app nudge"),
    ("workflow", "Workflow not customised in 30 days", "Offer onboarding session"),
    ("renewal", "Renewal in 60 days", "Open renewal task · send value report"),
    ("user_limit", "User limit above 90%", "Upsell offer to tenant admin"),
]
PLAYBOOK_EMAIL = False   # agreed: playbook e-mails are not sent for now (reported as not sent)
CACHE_SECONDS = 300
_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
_ready: dict = {}


def ensure_schema() -> bool:
    if _ready.get("schema"):
        return False
    for model in (PlatformCsPlaybook, PlatformCsCondition, PlatformCsAction, PlatformCsTask, PlatformCsRun):
        model.__table__.create(bind=master_engine, checkfirst=True)
    _ready["schema"] = True
    return True


# ─── Tenant-database reads ───────────────────────────────────────────────────

def _read_tenant(slug: str) -> dict:
    """Module adoption counts and activity signals from the tenant's own database (aggregates only)."""
    out = {"available": False, "error": None, "modules": {}, "days_since_signin": None, "workflow_days": None, "seats": None}
    try:
        s = get_tenant_session(slug)
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"Tenant database unavailable: {type(exc).__name__}"
        return out
    try:
        now = s.execute(text("SELECT NOW()")).scalar()
        since = now - timedelta(days=30)
        present = {r[0] for r in s.execute(text("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")).all()}
        out["seats"] = int(s.execute(text("SELECT COUNT(*) FROM users WHERE is_active = 1")).scalar() or 0)
        for label, _key, table, sql in MODULES:
            out["modules"][label] = int(s.execute(text(sql), {"since": since}).scalar() or 0) if table in present else None
        if "user_sessions" in present:
            out["days_since_signin"] = s.execute(text("SELECT TIMESTAMPDIFF(DAY, MAX(login_time), NOW()) FROM user_sessions")).scalar()
        stamps = [f"(SELECT MAX(`{col}`) FROM `{t}`)" for t, col in WORKFLOW_TABLES.items() if t in present]
        if stamps:
            out["workflow_days"] = s.execute(text(f"SELECT TIMESTAMPDIFF(DAY, GREATEST({', '.join(f'COALESCE({x}, 0)' for x in stamps)}), NOW())")).scalar()
            if out["workflow_days"] is not None and out["workflow_days"] > 100_000:   # GREATEST of zeros → never customised
                out["workflow_days"] = None
        out["available"] = True
    except Exception as exc:  # noqa: BLE001
        logger.warning("Customer success read failed for tenant %s", slug, exc_info=True)
        out["error"] = f"Tenant database could not be read: {type(exc).__name__}"
    finally:
        s.close()
    return out


def _tenant_reads(tenants: list[Tenant], refresh: bool) -> dict[int, tuple[dict, dict]]:
    """(adoption read, usage read) per tenant – cached 5 minutes, tenants read in parallel."""
    def one(t: Tenant):
        key = t.slug
        with _cache_lock:
            hit = _cache.get(key)
        if hit and not refresh and time.time() - hit[0] < CACHE_SECONDS:
            mine = hit[1]
        else:
            mine = _read_tenant(t.slug)
            with _cache_lock:
                _cache[key] = (time.time(), mine)
        return t.id, (mine, usage.tenant_usage(t, None, refresh=refresh))
    if not tenants:
        return {}
    with ThreadPoolExecutor(max_workers=min(8, len(tenants))) as pool:
        return dict(pool.map(one, tenants))


# ─── Health ──────────────────────────────────────────────────────────────────

def _entitlements(db: Session, tenants: list[Tenant]) -> dict[int, set[str]]:
    """Effective feature keys per tenant (its own rows, else its plan's – as the entitlement editor reads them), batched."""
    keys = {f.id: f.key for f in db.query(Feature.id, Feature.key).all()}
    own: dict[int, set[int]] = {}
    for tid, fid in db.query(TenantFeature.tenant_id, TenantFeature.feature_id).filter(
            TenantFeature.tenant_id.in_([t.id for t in tenants] or [0]), TenantFeature.enabled == True).all():  # noqa: E712
        own.setdefault(tid, set()).add(fid)
    plans: dict[int, set[int]] = {}
    for pid, fid in db.query(PlanFeature.plan_id, PlanFeature.feature_id).filter(
            PlanFeature.plan_id.in_({t.plan_id for t in tenants if t.plan_id} or {0}), PlanFeature.enabled == True).all():  # noqa: E712
        plans.setdefault(pid, set()).add(fid)
    return {t.id: {keys[f] for f in (own.get(t.id) or plans.get(t.plan_id, set())) if f in keys} for t in tenants}


def _support(db: Session, ids: list[int], now: datetime) -> dict[int, dict]:
    from app.models.platform_sla import PlatformTicketSla as Sl
    from app.models.platform_support import PlatformSupportTicket as Tk
    out: dict[int, dict] = {}
    for tid, prio, created, closed, due in db.query(Tk.tenant_id, Tk.priority, Tk.created_at, Tk.closed_at, Sl.resolution_due).outerjoin(
            Sl, Sl.ticket_id == Tk.id).filter(Tk.tenant_id.in_(ids or [0]), Tk.created_at >= now - timedelta(days=90)).all():
        # the ticket's own SLA resolution deadline (SLA & CSAT) when it has one, else the fixed target by priority
        target = due - created if due is not None else timedelta(days=TARGET_DAYS.get(prio, 3))
        r = out.setdefault(tid, {"met": 0, "missed": 0, "pending": 0})
        if closed is not None:
            r["met" if closed - created <= target else "missed"] += 1
        elif now - created > target:
            r["missed"] += 1
        else:
            r["pending"] += 1
    return out


def _billing(db: Session, ids: list[int], today: date) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for tid, due, paid in db.query(billing.PlatformInvoice.tenant_id, billing.PlatformInvoice.due_on, billing.PlatformInvoice.paid_on).filter(
            billing.PlatformInvoice.tenant_id.in_(ids or [0]), billing.PlatformInvoice.due_on <= today,
            billing.PlatformInvoice.due_on >= today - timedelta(days=365)).all():
        r = out.setdefault(tid, {"on_time": 0, "late": 0})
        r["on_time" if paid is not None and paid <= due else "late"] += 1
    return out


def score(factors: dict[str, Optional[float]]) -> tuple[Optional[int], list[str]]:
    """Weighted health from the measured factors; None when they carry less than MIN_WEIGHT of the weight."""
    measured = [(w, factors[k]) for k, _n, w in WEIGHTS if factors.get(k) is not None]
    missing = [n for k, n, _w in WEIGHTS if factors.get(k) is None]
    weight = sum(w for w, _ in measured)
    if weight < MIN_WEIGHT:
        return None, missing
    return round(sum(w * v for w, v in measured) / weight), missing


def risk(health: Optional[int]) -> Optional[str]:
    return None if health is None else "High" if health < 65 else "Medium" if health < 78 else "Low"


def health_rows(db: Session, scope: Optional[set[int]], refresh: bool = False) -> list[dict]:
    from app.services import platform_mobile
    q = db.query(Tenant).filter(Tenant.status != "cancelled")
    if scope is not None:
        q = q.filter(Tenant.id.in_(list(scope) or [0]))
    tenants = q.order_by(Tenant.name).all()
    now, today = datetime.utcnow(), date.today()
    ids = [t.id for t in tenants]
    ent = _entitlements(db, tenants)
    mobile = platform_mobile.tenant_settings(db, tenants)
    sup, bill = _support(db, ids, now), _billing(db, ids, today)
    prices = billing.tenant_prices(db, tenants)
    reads = _tenant_reads(tenants, refresh)
    rows = []
    for t in tenants:
        mine, use = reads[t.id]
        f: dict[str, Optional[float]] = {}
        notes: dict[str, str] = {}
        seats = mine.get("seats") if mine["available"] else (use.get("active_users") if use.get("available") else None)
        # usage
        if use.get("available") and use.get("active_users"):
            f["usage"] = round(100 * use["active_by_days"].get(30, 0) / use["active_users"])
            notes["usage"] = f"{use['active_by_days'].get(30, 0)} of {use['active_users']} active users signed in · 30 days"
        else:
            f["usage"] = None
            notes["usage"] = use.get("error") or "no active users"
        # adoption (entitled modules only)
        adoption: dict[str, dict] = {}
        for label, key, _table, _sql in MODULES:
            entitled = mobile[t.id]["enabled"] if key is None else key in ent[t.id]
            n = mine["modules"].get(label) if mine["available"] else None
            if not entitled:
                adoption[label] = {"pct": None, "note": "not in plan"}
            elif n is None or not seats:
                adoption[label] = {"pct": None, "note": mine.get("error") or ("module not set up" if mine["available"] else "unavailable")}
            else:
                adoption[label] = {"pct": round(100 * n / seats), "users": n, "note": f"{n} of {seats} active users · 30 days"}
        vals = [a["pct"] for a in adoption.values() if a["pct"] is not None]
        f["adoption"] = round(sum(vals) / len(vals)) if vals else None
        notes["adoption"] = f"mean of {len(vals)} entitled module(s)" if vals else (mine.get("error") or "no entitled module measured")
        # support
        s = sup.get(t.id)
        counted = (s["met"] + s["missed"]) if s else 0
        f["support"] = round(100 * s["met"] / counted) if counted else None
        notes["support"] = f"{s['met']} of {counted} tickets resolved within target · 90 days" if counted else "no Support Desk tickets to measure · 90 days"
        # billing
        b = bill.get(t.id)
        due = (b["on_time"] + b["late"]) if b else 0
        f["billing"] = round(100 * b["on_time"] / due) if due else None
        notes["billing"] = (f"{b['on_time']} of {due} invoices paid by the due date · 12 months" if due
                            else "not billed (trial)" if billing.is_trial(t) else "no invoices due · 12 months")
        f["nps"], notes["nps"] = None, "no survey data"
        h, missing = score(f)
        paying = billing.is_paying(t) and prices[t.id]["monthly"] > 0
        renewal = t.subscription_end_date or (t.trial_ends_at if billing.is_trial(t) else None)
        rows.append({"id": t.id, "name": t.name, "slug": t.slug, "status": t.status, "health": h, "risk": risk(h), "missing": missing,
                     "factors": f, "notes": notes, "adoption": adoption, "arr": prices[t.id]["monthly"] * 12 if paying else Decimal("0.00"),
                     "renewal": renewal.date().isoformat() if renewal else None,
                     "renewal_kind": None if not renewal else "subscription" if t.subscription_end_date else "trial ends",
                     "days_since_signin": mine.get("days_since_signin"), "workflow_days": mine.get("workflow_days"),
                     "seats": seats, "max_users": t.max_users, "onboarded_days": (now - t.created_at).days if t.created_at else None,
                     "data_error": mine.get("error") or use.get("error")})
    return rows


def kpis(rows: list[dict], today: Optional[date] = None) -> dict:
    today = today or date.today()
    scored = [r for r in rows if r["health"] is not None]
    upcoming = [r for r in rows if r["renewal"] and today <= date.fromisoformat(r["renewal"]) <= today + timedelta(days=90)]
    return {"avg_health": round(sum(r["health"] for r in scored) / len(scored)) if scored else None, "scored": len(scored), "tenants": len(rows),
            "at_risk": sum(1 for r in scored if r["risk"] == "High"),
            "arr_at_risk": sum((r["arr"] for r in scored if r["risk"] != "Low"), Decimal("0.00")),
            "nps": None, "renewals_90d": len(upcoming), "renewals_trial": sum(1 for r in upcoming if r["renewal_kind"] == "trial ends")}


SORT = {"t": lambda r: r["name"].lower(), "h": lambda r: r["health"], "u": lambda r: r["factors"]["usage"], "a": lambda r: r["factors"]["adoption"],
        "sp": lambda r: r["factors"]["support"], "n": lambda r: r["factors"]["nps"], "arr": lambda r: r["arr"], "ren": lambda r: r["renewal"],
        "risk": lambda r: {"High": 0, "Medium": 1, "Low": 2}.get(r["risk"], 3)}


def page(rows: list[dict], q: str, sorts: list[tuple[str, int]], offset: int, limit: int) -> dict:
    if q:
        rows = [r for r in rows if q.lower() in f"{r['name']} {r['slug']} {r['risk'] or 'not scored'}".lower()]
    for k, d in reversed(sorts or [("t", 1)]):      # stable sorts, last key first; missing values always last
        key = SORT.get(k)
        if key:
            rows = sorted((r for r in rows if key(r) is not None), key=key, reverse=d < 0) + [r for r in rows if key(r) is None]
    return {"items": rows[offset:offset + limit], "total": len(rows), "offset": offset, "limit": limit}


# ─── Playbooks ───────────────────────────────────────────────────────────────

def playbooks(db: Session) -> list[dict]:
    stored = {r.key: r for r in db.query(PlatformCsPlaybook).all()}
    return [{"key": k, "title": t, "actions": a, "enabled": stored[k].enabled if k in stored else True} for k, t, a in PLAYBOOKS]


def set_playbook(db: Session, key: str, enabled: bool, actor: str) -> tuple[bool, bool]:
    if key not in {k for k, _, _ in PLAYBOOKS}:
        raise KeyError(key)
    row = db.get(PlatformCsPlaybook, key)
    old = row.enabled if row else True
    if row is None:
        row = PlatformCsPlaybook(key=key)
        db.add(row)
    row.enabled, row.updated_by, row.updated_at = enabled, actor, datetime.utcnow()
    return old, enabled


def matches(rule: str, r: dict, today: date) -> Optional[str]:
    """The episode key when the rule's condition holds for the row, else None."""
    if r["status"] not in ("active", "trial"):
        return None
    if rule == "health_low":
        return "" if r["health"] is not None and r["health"] < 65 else None
    if rule == "no_signin":
        if r["data_error"]:
            return None
        return "" if r["days_since_signin"] is None or r["days_since_signin"] >= 14 else None
    if rule == "workflow":
        if r["data_error"] or (r["onboarded_days"] or 0) < 30:
            return None
        return "" if r["workflow_days"] is None or r["workflow_days"] >= 30 else None
    if rule == "renewal":
        return r["renewal"] if r["renewal"] and today <= date.fromisoformat(r["renewal"]) <= today + timedelta(days=60) else None
    if rule == "user_limit":
        return "" if r["seats"] is not None and r["max_users"] and r["seats"] / r["max_users"] > 0.9 else None
    return None


def _messages(rule: str, r: dict) -> dict:
    """Task title / in-app message per rule (actions are listed in the order the prototype names them)."""
    seat = f"{r['seats']} of {r['max_users']} users" if r["seats"] is not None else ""
    return {
        "health_low": {"task": ("Health below 65 – assign CSM, schedule a call, offer training", 3),
                       "in_app": ("Training for your team", "Your platform success team would like to offer your team a free training session. Reply to the email or contact support to book a time.")},
        "no_signin": {"email": ("We miss you on the CRM", f"No one from {r['name']} has signed in for 14 days."),
                      "in_app": ("Pick up where you left off", "Nobody from your organisation has signed in for 14 days. Need help getting your team started? Contact support.")},
        "workflow": {"task": ("Offer an onboarding session (workflow not customised)", 7),
                     "in_app": ("Tailor your workflows", "Your workflows haven't been customised in 30 days. We can run a free onboarding session to set them up with you – contact support to book one.")},
        "renewal": {"task": (f"Renewal due {r['renewal']} – open renewal conversation", 7),
                    "email": ("Your value report", f"Value report for {r['name']} ahead of the renewal on {r['renewal']}.")},
        "user_limit": {"in_app": ("You're close to your user limit", f"Your organisation is using {seat} included in its plan. Talk to us about more seats or a higher plan.")},
    }[rule]


def _assignee(db: Session, tenant_id: int, cache: dict) -> Optional[SuperAdmin]:
    """Platform user with Tenants manage access to the tenant and the fewest open customer-success tasks."""
    if "staff" not in cache:
        staff = []
        for a in db.query(SuperAdmin).filter(SuperAdmin.is_active == True).order_by(SuperAdmin.id).all():  # noqa: E712
            acc = pa.staff_access(db, a)
            if pa.can(acc, "tenants", "manage"):
                staff.append((a, None if acc["scope"] == "all" else set(acc["tenant_ids"])))
        cache["staff"] = staff
        cache["load"] = dict(db.query(PlatformCsTask.assignee_admin_id, func.count(PlatformCsTask.id)).filter(PlatformCsTask.status == "open")
                             .group_by(PlatformCsTask.assignee_admin_id).all())
    pool = [a for a, ids in cache["staff"] if ids is None or tenant_id in ids]
    if not pool:
        return None
    pick = min(pool, key=lambda a: (cache["load"].get(a.id, 0), a.id))
    cache["load"][pick.id] = cache["load"].get(pick.id, 0) + 1
    return pick


def _do(db: Session, run: PlatformCsRun, rule: str, tenant: Tenant, row: dict, episode: str, action: str, payload, cache: dict) -> dict:
    """Run one action unless it already succeeded for this episode. Returns {status, detail}."""
    from app.services import tenant_hierarchy
    existing = db.query(PlatformCsAction).filter(PlatformCsAction.rule == rule, PlatformCsAction.tenant_id == tenant.id,
                                                 PlatformCsAction.episode == episode, PlatformCsAction.action == action).with_for_update().first()
    if existing is not None and existing.status == "done":
        return {"status": "already_done", "detail": existing.detail}
    if action == "task":
        title, due_days = payload
        who = _assignee(db, tenant.id, cache)
        task = PlatformCsTask(tenant_id=tenant.id, rule=rule, episode=episode, title=title, detail=row["notes"].get("usage"),
                              assignee_admin_id=who.id if who else None, due_on=date.today() + timedelta(days=due_days))
        db.add(task)
        db.flush()
        status, detail = "done", f"task #{task.id} for {who.full_name or who.email}" if who else f"task #{task.id} created – no platform user with Tenants manage access to assign"
    elif action == "in_app":
        title, message = payload
        try:
            n = tenant_hierarchy.send_announcement(tenant, title, message, roles=["admin"])
            status, detail = ("done", f"in-app notification to {n} admin(s)") if n else ("failed", "no active admin users")
        except Exception as exc:  # noqa: BLE001
            status, detail = "failed", f"in-app notification failed: {type(exc).__name__}"
    else:
        status, detail = "not_sent", "email not sent – playbook e-mails are switched off"
        if PLAYBOOK_EMAIL:
            from app.services.platform_trust_safety import send_mail
            sent, what = send_mail(tenant.billing_email or tenant.admin_email, payload[0], payload[1])
            status, detail = ("done" if sent else "failed"), what
    if existing is None:
        db.add(PlatformCsAction(run_id=run.id, rule=rule, tenant_id=tenant.id, episode=episode, action=action, status=status, detail=detail[:300]))
    else:
        existing.run_id, existing.status, existing.detail, existing.attempts, existing.updated_at = run.id, status, detail[:300], existing.attempts + 1, datetime.utcnow()
    db.commit()       # each action is kept as soon as it happened, so a later failure can't make it run twice
    return {"status": status, "detail": detail}


def run(db: Session, scope: Optional[set[int]], actor: str, audit) -> dict:
    """Evaluate enabled playbooks for the tenants in scope and run their actions once per episode.

    ``audit(action, tenant, description, data)`` writes a platform audit row. One run at a time (named lock)."""
    lock = master_engine.connect()      # named locks belong to a connection; the session's changes connection on commit
    if not lock.execute(text("SELECT GET_LOCK('platform_cs_playbook_run', 0)")).scalar():
        lock.close()
        raise RuntimeError("A playbook run is already in progress")
    try:
        rows = health_rows(db, scope, refresh=True)
        enabled = [p["key"] for p in playbooks(db) if p["enabled"]]
        tenants = {t.id: t for t in db.query(Tenant).filter(Tenant.id.in_([r["id"] for r in rows] or [0])).all()}
        conds = {(c.rule, c.tenant_id): c for c in db.query(PlatformCsCondition).filter(PlatformCsCondition.tenant_id.in_(list(tenants) or [0])).all()}
        record = PlatformCsRun(started_by=actor, started_at=datetime.utcnow())
        db.add(record)
        db.commit()
        today, cache, results = date.today(), {}, []
        for r in rows:
            for rule in enabled:
                ep = matches(rule, r, today)
                cond = conds.get((rule, r["id"]))
                if ep is None:
                    if cond is not None:
                        db.delete(cond)      # condition cleared: the next match is a new episode
                    continue
                if cond is None or (rule == "renewal" and cond.episode != ep):
                    if cond is not None:
                        db.delete(cond)
                        db.flush()
                    cond = PlatformCsCondition(rule=rule, tenant_id=r["id"], episode=ep or f"{datetime.utcnow():%Y%m%dT%H%M%S}-{secrets.token_hex(3)}", since=datetime.utcnow())
                    db.add(cond)
                    db.flush()
                for action, payload in _messages(rule, r).items():
                    res = _do(db, record, rule, tenants[r["id"]], r, cond.episode, action, payload, cache)
                    results.append({"tenant_id": r["id"], "tenant": r["name"], "rule": rule, "action": action, **res})
                    if res["status"] in ("done", "failed"):
                        audit(f"cs_playbook_{action}" + ("_failed" if res["status"] == "failed" else ""), tenants[r["id"]],
                              f"Playbook “{dict((k, t) for k, t, _ in PLAYBOOKS)[rule]}” – {res['detail']}", {"rule": rule, "episode": cond.episode, "run_id": record.id})
                        db.commit()
        count = {s: sum(1 for x in results if x["status"] == s) for s in ("done", "failed", "already_done", "not_sent")}
        matched = len({(x["tenant_id"], x["rule"]) for x in results})
        outcome = "no_matches" if not results else "failed" if count["failed"] and not count["done"] and not count["already_done"] \
            else "partial" if count["failed"] else "success"
        record.finished_at, record.outcome = datetime.utcnow(), outcome
        record.summary = {"tenants": len(rows), "rules": enabled, "matched": matched, **count, "results": results[:200]}
        audit("cs_playbook_run" + ("_failed" if outcome == "failed" else ""), None,
              f"Run playbook: {matched} match(es), {count['done']} action(s) done, {count['failed']} failed, {count['already_done']} already done, "
              f"{count['not_sent']} e-mail(s) not sent ({outcome})", {"run_id": record.id, "outcome": outcome, **count})
        db.commit()
        return {"run_id": record.id, "outcome": outcome, "matched": matched, "tenants": len(rows), **count, "results": results}
    except Exception:
        db.rollback()
        raise
    finally:
        lock.execute(text("SELECT RELEASE_LOCK('platform_cs_playbook_run')"))
        lock.close()
