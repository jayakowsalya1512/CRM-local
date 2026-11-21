"""Revenue analytics (Command → Revenue Analytics).

Current MRR uses the Billing & Metering rule (``platform_billing.recurring``): a tenant contributes its monthly price –
the negotiated tenant price when recorded, else the plan price – while it is paying (status active and billing status
not trial / free / cancelled). One-time and usage charges are never recurring. ARR = MRR × 12.

Past periods come only from the subscription ledger (``platform_subscription_events``): every change of a tenant's plan,
status, billing status or price is recorded on commit (session listener), and a periodic reconcile catches changes made
outside the ORM and deleted tenants. The ledger starts with a baseline of every tenant; nothing before it is inferred.
Windows that reach back before the baseline are shortened to it and say so.

Customers (logo churn, cohorts) are paying accounts. A cohort is the fiscal quarter (April–March) in which an account
first became paying after the ledger started; accounts already paying at the baseline have no known start and are left out.
"""

from __future__ import annotations

import bisect
import calendar
import logging
import threading
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Iterable, Optional

from sqlalchemy import event, func, inspect, text
from sqlalchemy.orm import Session

from app.database import MasterSessionLocal, master_engine
from app.models.platform_revenue import PlatformSubscriptionEvent as Ev
from app.models.tenant import Plan, Tenant, TenantPlanSnapshot
from app.services import platform_billing as billing

logger = logging.getLogger(__name__)
IST = timedelta(hours=5, minutes=30)          # month and quarter boundaries follow Indian time
ZERO = Decimal("0.00")
TRACKED = ("plan_id", "status", "billing_status")
_ready: dict = {}


def ensure_schema() -> bool:
    if _ready.get("schema"):
        return False
    Ev.__table__.create(bind=master_engine, checkfirst=True)
    _ready["schema"] = True
    return True


# ─── Ledger ──────────────────────────────────────────────────────────────────

def _current(db: Session, tenant_ids: Optional[Iterable[int]] = None) -> dict[int, dict]:
    """Each tenant's recurring state now (Billing & Metering rule)."""
    q = db.query(Tenant)
    if tenant_ids is not None:
        q = q.filter(Tenant.id.in_(list(tenant_ids) or [0]))
    tenants = q.all()
    prices = billing.tenant_prices(db, tenants)
    from app.services import platform_discounts as discounts
    effective = discounts.effective_mrr(db, [t for t in tenants if billing.is_paying(t) and prices[t.id]["monthly"] > 0], prices)
    from app.services import platform_addons as addons
    extra = addons.addon_mrr_by_tenant(db, [t.id for t in tenants])
    out = {}
    for t in tenants:
        paying = billing.is_paying(t) and prices[t.id]["monthly"] > 0
        out[t.id] = {"name": t.name, "plan_id": t.plan_id, "status": t.status, "billing_status": t.billing_status, "paying": paying,
                     "mrr": effective[t.id] + extra.get(t.id, ZERO) if paying else ZERO}  # effective MRR after recurring discounts, plus add-ons
    return out


def _latest(db: Session, tenant_ids: Optional[Iterable[int]] = None) -> dict[int, Ev]:
    sub = db.query(Ev.tenant_id, func.max(Ev.id).label("mid")).group_by(Ev.tenant_id)
    if tenant_ids is not None:
        sub = sub.filter(Ev.tenant_id.in_(list(tenant_ids) or [0]))
    sub = sub.subquery()
    return {e.tenant_id: e for e in db.query(Ev).join(sub, sub.c.mid == Ev.id).all()}


def _kind(prev: Optional[Ev], mrr: Decimal, paid_before: bool) -> str:
    pm = prev.mrr if prev is not None else ZERO
    if pm == 0 and mrr > 0:
        return "reactivation" if paid_before else "new"
    if pm > 0 and mrr == 0:
        return "churn"
    if mrr > pm:
        return "expansion"
    if mrr < pm:
        return "contraction"
    return "change" if prev is not None else "signup"


def record(tenant_ids: Optional[Iterable[int]] = None, source: str = "reconcile") -> int:
    """Compare tenants' current recurring state with the ledger and write an event for each difference.

    Runs in its own transaction under a named lock, so the commit listener, the periodic check and page loads never
    write the same change twice. Returns the number of events written."""
    ensure_schema()
    ids = None if tenant_ids is None else sorted(set(tenant_ids))
    lock = master_engine.connect()      # named locks belong to a connection; the session's changes connection on commit
    db = MasterSessionLocal()
    try:
        if not lock.execute(text("SELECT GET_LOCK('platform_subscription_ledger', 10)")).scalar():
            logger.warning("Subscription ledger busy – changes will be picked up by the next check")
            return 0
        try:
            first_run = db.query(Ev.id).first() is None
            cur, last = _current(db, ids), _latest(db, ids)
            paid = {tid for (tid,) in db.query(Ev.tenant_id).filter(Ev.paying == True).distinct().all()}  # noqa: E712
            now, n = datetime.utcnow(), 0
            for tid, s in cur.items():
                prev = last.get(tid)
                if prev is not None and prev.kind != "deleted" and (prev.plan_id, prev.status, prev.billing_status, Decimal(prev.mrr)) == \
                        (s["plan_id"], s["status"], s["billing_status"], s["mrr"]):
                    continue
                kind = "baseline" if first_run else _kind(prev if prev is not None and prev.kind != "deleted" else None, s["mrr"], tid in paid)
                pm = Decimal(prev.mrr) if prev is not None else ZERO
                db.add(Ev(tenant_id=tid, tenant_name=s["name"][:200], occurred_at=now, kind=kind, plan_id=s["plan_id"], status=s["status"],
                          billing_status=s["billing_status"], paying=s["paying"], mrr=s["mrr"], mrr_delta=ZERO if kind == "baseline" else s["mrr"] - pm,
                          source="baseline" if kind == "baseline" else source))
                n += 1
            for tid, prev in last.items():
                if tid not in cur and prev.kind != "deleted":
                    db.add(Ev(tenant_id=tid, tenant_name=prev.tenant_name, occurred_at=now, kind="deleted", plan_id=prev.plan_id, status=None,
                              billing_status=None, paying=False, mrr=ZERO, mrr_delta=-Decimal(prev.mrr), source=source))
                    n += 1
            db.commit()
            return n
        finally:
            lock.execute(text("SELECT RELEASE_LOCK('platform_subscription_ledger')"))
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
        lock.close()


def _changed_tenants(session: Session) -> set[int]:
    """Tenants whose plan, status, billing status, negotiated price or add-ons changed in this flush (ids are assigned by now)."""
    ids = set()
    for obj in list(session.new) + list(session.dirty) + list(session.deleted):
        if isinstance(obj, Tenant):
            if obj in session.new or obj in session.deleted or any(inspect(obj).attrs[a].history.has_changes() for a in TRACKED):
                ids.add(obj.id)
        elif isinstance(obj, TenantPlanSnapshot):
            ids.add(obj.tenant_id)
        elif type(obj).__name__ == "PlatformTenantAddon":  # add-on subscriptions change MRR (platform_addons)
            ids.add(obj.tenant_id)
    ids.discard(None)
    return ids


def install_listener() -> None:
    """Record ledger events right after any ORM commit that changes a tenant's plan, status, billing status or price."""
    if _ready.get("listener"):
        return

    @event.listens_for(Session, "after_flush")
    def _collect(session, _ctx):
        found = _changed_tenants(session)   # after_flush still shows the pre-flush new / dirty / deleted lists and history
        if found:
            session.info.setdefault("pse_pending", set()).update(found)

    @event.listens_for(Session, "after_commit")
    def _commit(session):
        ids = session.info.pop("pse_pending", None)
        if ids:
            try:
                record(ids, "live")
            except Exception:  # noqa: BLE001 – the periodic check records it later
                logger.exception("Subscription ledger: recording on commit failed")

    @event.listens_for(Session, "after_rollback")
    def _rollback(session):
        session.info.pop("pse_pending", None)

    _ready["listener"] = True


def start_worker(interval: int = 600) -> None:
    """Periodic reconcile: catches changes made with plain SQL and deleted tenants."""
    if _ready.get("worker"):
        return
    stop = threading.Event()

    def loop():
        while not stop.wait(interval):
            try:
                record(None, "reconcile")
            except Exception:  # noqa: BLE001
                logger.exception("Subscription ledger reconcile failed")
    threading.Thread(target=loop, daemon=True, name="subscription-ledger").start()
    _ready["worker"] = stop


# ─── Analytics ───────────────────────────────────────────────────────────────

class _Timeline:
    """Each tenant's MRR over time, from one read of the ledger."""

    def __init__(self, rows, start: Optional[datetime]):
        self.start = start
        self.at: dict[int, list[datetime]] = {}
        self.mrr: dict[int, list[Decimal]] = {}
        self.first_paid: dict[int, datetime] = {}
        self.paying_at_baseline: set[int] = set()
        for tid, at, mrr, kind in rows:
            mrr = Decimal(mrr)
            self.at.setdefault(tid, []).append(at)
            self.mrr.setdefault(tid, []).append(mrr)
            if kind == "baseline":
                if mrr > 0:
                    self.paying_at_baseline.add(tid)
            elif mrr > 0 and tid not in self.first_paid and tid not in self.paying_at_baseline:
                self.first_paid[tid] = at

    def state(self, at: datetime) -> dict[int, Decimal]:
        out = {}
        for tid, times in self.at.items():
            i = bisect.bisect_right(times, at) - 1
            if i >= 0:
                out[tid] = self.mrr[tid][i]
        return out

    def mrr_of(self, tid: int, at: datetime) -> Decimal:
        i = bisect.bisect_right(self.at[tid], at) - 1
        return self.mrr[tid][i] if i >= 0 else ZERO


def _month_start(now: datetime, back: int = 0) -> datetime:
    local = now + IST
    y, m = local.year, local.month - back
    while m < 1:
        y, m = y - 1, m + 12
    return datetime(y, m, 1) - IST


def _add_months(at: datetime, n: int) -> datetime:
    y, m = divmod(at.month - 1 + n, 12)
    y, m = at.year + y, m + 1
    return at.replace(year=y, month=m, day=min(at.day, calendar.monthrange(y, m)[1]))


def fiscal_quarter(at: datetime) -> tuple[int, int]:
    """(fiscal year by its ending year, quarter) – Indian FY: Q1 = Apr–Jun."""
    local = at + IST
    return (local.year + 1 if local.month >= 4 else local.year), (local.month - 4) % 12 // 3 + 1


def _quarter_label(fy: int, q: int) -> str:
    return f"Q{q} FY{fy % 100:02d}"


def movement(start: dict[int, Decimal], end: dict[int, Decimal]) -> dict:
    """Net change per account between two points: End = Start + New + Expansion − Contraction − Churn."""
    m = {"start": ZERO, "new": ZERO, "expansion": ZERO, "contraction": ZERO, "churn": ZERO, "end": ZERO}
    counts = {"new": 0, "expansion": 0, "contraction": 0, "churn": 0}
    for tid in set(start) | set(end):
        s, e = start.get(tid, ZERO), end.get(tid, ZERO)
        m["start"] += s
        m["end"] += e
        key = "new" if s == 0 and e > 0 else "churn" if s > 0 and e == 0 else "expansion" if e > s else "contraction" if e < s else None
        if key:
            m[key] += abs(e - s)
            counts[key] += 1
    assert m["end"] == m["start"] + m["new"] + m["expansion"] - m["contraction"] - m["churn"]
    return {**m, "accounts": counts}


def _window(wanted: datetime, ledger_start: datetime) -> tuple[datetime, bool]:
    return (wanted, False) if wanted >= ledger_start else (ledger_start, True)


def overview(db: Session, scope: Optional[set[int]], now: Optional[datetime] = None) -> dict:
    now = now or datetime.utcnow()
    live = _current(db, scope)
    paying = {tid: s for tid, s in live.items() if s["paying"]}
    mrr = sum((s["mrr"] for s in paying.values()), ZERO)
    plan_names = {p.id: p.name for p in db.query(Plan.id, Plan.name).all()}
    by_plan: dict[str, dict] = {}
    for s in paying.values():
        row = by_plan.setdefault(plan_names.get(s["plan_id"], "No plan"), {"mrr": ZERO, "accounts": 0})
        row["mrr"] += s["mrr"]
        row["accounts"] += 1
    order = {p.name: i for i, p in enumerate(db.query(Plan).order_by(Plan.price_monthly, Plan.id).all())}

    q = db.query(Ev.tenant_id, Ev.occurred_at, Ev.mrr, Ev.kind)
    if scope is not None:
        q = q.filter(Ev.tenant_id.in_(list(scope) or [0]))
    # The ledger start is global (first baseline), not per scope: a tenant onboarded later has no baseline row.
    start = db.query(Ev.occurred_at).filter(Ev.kind == "baseline").order_by(Ev.occurred_at).limit(1).scalar()
    tl = _Timeline(q.order_by(Ev.tenant_id, Ev.occurred_at, Ev.id).all(), start)
    out = {"mrr": mrr, "arr": mrr * 12, "paying_accounts": len(paying), "trials": sum(1 for s in live.values() if s["status"] == "trial" or s["billing_status"] == "trial"),
           "arpa": (mrr / len(paying)).quantize(Decimal("0.01")) if paying else None,
           "plans": sorted(({"plan": k, **v} for k, v in by_plan.items()), key=lambda r: order.get(r["plan"], 99)),
           "ltv_cac": None, "ltv_cac_reason": "No acquisition-cost or margin data is recorded",
           "ledger_start": tl.start, "now": now}
    if tl.start is None:
        return {**out, "movement": None, "nrr": None, "churn": None, "mrr_change": None, "trend": [], "cohorts": _cohorts(tl, now)}
    end = tl.state(now)

    ms, cut = _window(_month_start(now), tl.start)
    mv = movement(tl.state(ms), end)
    out["movement"] = {**mv, "since": ms, "truncated": cut}
    out["mrr_change"] = float((mv["end"] - mv["start"]) / mv["start"] * 100) if not cut and mv["start"] > 0 else None

    ns, cut = _window(now - timedelta(days=365), tl.start)
    st = {t: v for t, v in tl.state(ns).items() if v > 0}
    base = sum(st.values(), ZERO)
    out["nrr"] = {"value": float(sum((end.get(t, ZERO) for t in st), ZERO) / base * 100) if base else None, "start_mrr": base,
                  "accounts": len(st), "since": ns, "truncated": cut}

    cs, cut = _window(now - timedelta(days=90), tl.start)
    st = [t for t, v in tl.state(cs).items() if v > 0]
    lost = [t for t in st if end.get(t, ZERO) == 0]
    out["churn"] = {"value": 100 * len(lost) / len(st) if st else None, "lost": len(lost), "accounts": len(st), "since": cs, "truncated": cut}

    trend = []
    for back in range(7, -1, -1):
        at = now if back == 0 else _month_start(now, back - 1)
        if at >= tl.start:
            trend.append(float(sum(tl.state(at).values(), ZERO)))
    out["trend"] = trend
    out["cohorts"] = _cohorts(tl, now)
    return out


def _cohorts(tl: _Timeline, now: datetime) -> dict:
    fy, q = fiscal_quarter(now)
    quarters = []
    for _ in range(6):
        quarters.append((fy, q))
        fy, q = (fy, q - 1) if q > 1 else (fy - 1, 4)
    quarters.reverse()
    members: dict[tuple[int, int], list[int]] = {k: [] for k in quarters}
    for tid, at in tl.first_paid.items():
        k = fiscal_quarter(at)
        if k in members:
            members[k].append(tid)
    rows = []
    for k in quarters:
        cells = []
        for month in range(1, 7):
            due = [(t, _add_months(tl.first_paid[t], month)) for t in members[k]]
            elig = [(t, d) for t, d in due if d <= now]
            if not elig:
                cells.append(None)       # no account has reached this month yet (or the cohort is empty)
            else:
                kept = sum(1 for t, d in elig if tl.mrr_of(t, d) > 0)
                cells.append({"pct": round(100 * kept / len(elig)), "retained": kept, "eligible": len(elig)})
        rows.append({"label": _quarter_label(*k), "accounts": len(members[k]), "cells": cells})
    return {"months": [f"M{i}" for i in range(1, 7)], "rows": rows, "paying_at_baseline": len(tl.paying_at_baseline)}
