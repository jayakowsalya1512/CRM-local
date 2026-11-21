"""Forecasts (prototype v17 · Sales → Forecasts): fiscal periods, KPI strip, Forecast by rep, Composition, manager
adjustments and Submit forecast.

Sources (nothing is hard-coded):
* Deals            – deal_service.deal_query (opportunities.view + the role's opportunity data scope) and the deal's
                     current stage on its pipeline (Pipelines & Stages / Process Designer: stage kind + win %).
* Win probability  – the stage's configured win % (deal_service.pipelines → ``prob``).
* Owner / rep      – leads.assigned_to (else the creator); names from Users & Teams.
* Quotas           – Sales quotas & targets (kam_targets): the monthly target ``YYYY-MM`` of every month in the period,
                     else 1/12 of the calendar-year target ``YYYY`` for that month. ``sales_target`` wins over
                     ``revenue_target``.
* Fiscal calendar  – Settings ``fiscal_year_start`` (month, default 04 → FY Apr–Mar).
* Forecast settings– tenant ``settings`` (category "forecasts"): commit / best-case thresholds (default 70 % / 40 %),
                     forecast period (Quarterly / Monthly / Annual), manager adjustments on/off, lock at period start.

Classification for a period [start, end] (Decimal arithmetic throughout):
* Closed won – deals on a won stage whose win date (converted_at → won-stage entry → close date) falls in the period.
* Open deals – counted when their expected close date is in the period; open deals with no close date or a close date
               already past roll into the period that contains today. Commit ≥ commit %, Best case ≥ best % and < commit %,
               Pipeline < best %. Lost deals are never counted.
* Gap to quota = MAX(0, Quota − Closed won − Commit − Manager adjustments)
* Attainment % = (Closed + Commit + Manager adj.) / Quota × 100 (None when the quota is 0)
* Composition centre = (Closed + Commit) / Quota × 100 (None when the quota is 0)

Every page load runs a fixed number of batched queries (deals, profiles + stages, users, quotas, adjustments, latest
submission) – no per-rep or per-deal queries.
"""
from __future__ import annotations

import calendar
import logging
import threading
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy import func, text
from sqlalchemy.orm import Session, load_only

from app.core.timezone import now_ist, today_ist
from app.dependencies import get_request_ip, user_has_permission
from app.models.all_models import KAMTarget, Lead, Setting, User
from app.models.deals import DealProfile
from app.models.forecasts import FORECAST_TABLES, ForecastAdjustment, ForecastSubmission, ForecastSubmissionLine

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

MODULE = "forecasts"                     # permissions, audit log, notifications
APPROVAL_MODULE, APPROVAL_ACTION = "forecast", "submit"
ZERO = Decimal("0")
CENT = Decimal("0.01")
MAX_ADJ = Decimal("9999999999999.99")
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Settings → Forecast settings (tenant ``settings`` table, category "forecasts"): key, label, type, default
CONFIG_KEYS: dict[str, tuple[str, str, str, Any]] = {
    "commit_min": ("forecast_commit_min_prob", "Minimum probability to count as commit (%)", "number", 70),
    "best_min": ("forecast_best_min_prob", "Minimum probability to count as best case (%)", "number", 40),
    "period": ("forecast_period", "Forecast period", "string", "Quarterly"),
    "adjustments": ("forecast_adjustments", "Manager adjustments", "boolean", True),
    "lock": ("forecast_lock", "Lock forecast at period start", "boolean", False),
}
PERIOD_TYPES = ("Quarterly", "Monthly", "Annual")


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        for t in FORECAST_TABLES:
            t.create(bind=db.get_bind(), checkfirst=True)
        db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    m = MasterSessionLocal()
    try:
        slugs = [t.slug for t in m.query(Tenant).all()]
    finally:
        m.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
        except Exception as exc:
            logger.warning("forecasts schema: tenant %s unavailable: %s", slug, exc)
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
        except Exception as exc:
            logger.warning("forecasts schema for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()


# ─── settings ─────────────────────────────────────────────────────────────────

def _bool(v: str) -> bool:
    return v.strip().lower() in ("1", "true", "yes", "on")


def config(db: Session) -> dict[str, Any]:
    keys = [k for k, _, _, _ in CONFIG_KEYS.values()] + ["fiscal_year_start"]
    rows = {s.key: (s.value or "").strip() for s in db.query(Setting.key, Setting.value).filter(Setting.key.in_(keys)).all()}
    out: dict[str, Any] = {}
    for name, (key, _, typ, default) in CONFIG_KEYS.items():
        v = rows.get(key, "")
        if v == "":
            out[name] = default
        elif typ == "number":
            try:
                out[name] = max(0, min(100, int(float(v))))
            except ValueError:
                out[name] = default
        elif typ == "boolean":
            out[name] = _bool(v)
        else:
            out[name] = v if name != "period" or v in PERIOD_TYPES else default
    if out["best_min"] > out["commit_min"]:             # keep the bands ordered even if mis-configured
        out["best_min"] = out["commit_min"]
    try:
        m0 = int(rows.get("fiscal_year_start") or 4)
    except ValueError:
        m0 = 4
    out["fy_start_month"] = m0 if 1 <= m0 <= 12 else 4
    return out


def save_config(db: Session, cu: User, values: dict[str, Any]) -> dict[str, Any]:
    cur = config(db)
    nxt = dict(cur)
    for name, raw in values.items():
        if name not in CONFIG_KEYS or raw is None:
            continue
        key, label, typ, _ = CONFIG_KEYS[name]
        if typ == "number":
            try:
                n = int(raw)
            except (TypeError, ValueError):
                raise HTTPException(422, f"{label} must be a whole number")
            if not 0 <= n <= 100:
                raise HTTPException(422, f"{label} must be between 0 and 100")
            nxt[name] = n
        elif typ == "boolean":
            nxt[name] = raw if isinstance(raw, bool) else _bool(str(raw))
        else:
            if str(raw) not in PERIOD_TYPES:
                raise HTTPException(422, f"{label} must be one of {', '.join(PERIOD_TYPES)}")
            nxt[name] = str(raw)
    if nxt["best_min"] > nxt["commit_min"]:
        raise HTTPException(422, "The best-case threshold must not be above the commit threshold")
    existing = {s.key: s for s in db.query(Setting).filter(Setting.key.in_([k for k, _, _, _ in CONFIG_KEYS.values()])).all()}
    for name, (key, label, typ, _) in CONFIG_KEYS.items():
        v = nxt[name]
        sv = ("true" if v else "false") if typ == "boolean" else str(v)
        row = existing.get(key)
        if row is None:
            db.add(Setting(key=key, value=sv, type={"number": "number", "boolean": "boolean"}.get(typ, "string"), category="forecasts", label=label, updated_by=cu.id))
        elif row.value != sv:
            row.value, row.updated_by = sv, cu.id
    from app.core.logging import log_audit_db
    log_audit_db(db, cu.id, MODULE, "settings_update", None, "", description="Forecast settings updated",
                 old_data={k: cur[k] for k in CONFIG_KEYS}, new_data={k: nxt[k] for k in CONFIG_KEYS})
    db.commit()
    return config(db)


# ─── fiscal periods ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Period:
    key: str
    label: str        # chip label: FY 2026-27 | Q3 | Nov
    full: str         # FY 2026-27 · Q3 (Oct–Dec 2026)
    kind: str         # fy | quarter | month
    start: date
    end: date


def _add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    return date(d.year + m // 12, m % 12 + 1, 1)


def _fy_label(y: int, m0: int) -> str:
    return f"FY {y}" if m0 == 1 else f"FY {y}-{(y + 1) % 100:02d}"


def fiscal_year_of(d: date, m0: int) -> int:
    return d.year if d.month >= m0 else d.year - 1


def parse_period(key: str, m0: int) -> Period:
    """``FY2026`` | ``FY2026-Q3`` | ``FY2026-M08`` → Period (dates from the fiscal calendar)."""
    k = (key or "").strip().upper()
    try:
        if not k.startswith("FY") or len(k) < 6:
            raise ValueError
        y = int(k[2:6])
        if not 1990 <= y <= 2200:
            raise ValueError
        fy0 = date(y, m0, 1)
        fy = _fy_label(y, m0)
        if len(k) == 6:
            end = _add_months(fy0, 12) - timedelta(days=1)
            return Period(f"FY{y}", fy, fy, "fy", fy0, end)
        part = k[7:]
        if k[6] != "-" or len(part) < 2:
            raise ValueError
        if part[0] == "Q":
            q = int(part[1:])
            if not 1 <= q <= 4:
                raise ValueError
            s = _add_months(fy0, 3 * (q - 1))
            e = _add_months(s, 3) - timedelta(days=1)
            rng = f"{MON[s.month - 1]}–{MON[e.month - 1]} {e.year}"
            return Period(f"FY{y}-Q{q}", f"Q{q}", f"{fy} · Q{q} ({rng})", "quarter", s, e)
        if part[0] == "M":
            n = int(part[1:])
            if not 1 <= n <= 12:
                raise ValueError
            s = _add_months(fy0, n - 1)
            e = _add_months(s, 1) - timedelta(days=1)
            return Period(f"FY{y}-M{n:02d}", MON[s.month - 1], f"{fy} · {MON[s.month - 1]} {s.year}", "month", s, e)
    except (ValueError, IndexError):
        pass
    raise HTTPException(422, "Select a valid forecast period")


def available_periods(cfg: dict[str, Any], today: Optional[date] = None) -> list[Period]:
    """Prototype chips FY 2026-27 · Q3 · Q4: the current fiscal year, then its current and remaining quarters
    (Monthly: the current and next two months of the year; Annual: the fiscal year only)."""
    today = today or today_ist()
    m0 = cfg["fy_start_month"]
    y = fiscal_year_of(today, m0)
    out = [parse_period(f"FY{y}", m0)]
    idx = (today.year - y) * 12 + today.month - m0          # 0-based month index inside the fiscal year
    if cfg["period"] == "Quarterly":
        out += [parse_period(f"FY{y}-Q{q}", m0) for q in range(idx // 3 + 1, 5)]
    elif cfg["period"] == "Monthly":
        out += [parse_period(f"FY{y}-M{n:02d}", m0) for n in range(idx + 1, min(12, idx + 3) + 1)]
    return out


def _period_json(p: Period) -> dict[str, Any]:
    return {"key": p.key, "label": p.label, "full": p.full, "kind": p.kind, "start": p.start.isoformat(), "end": p.end.isoformat()}


# ─── calculations ─────────────────────────────────────────────────────────────

def _d(v: Any) -> Decimal:
    if v is None:
        return ZERO
    try:
        return v if isinstance(v, Decimal) else Decimal(str(v))
    except (InvalidOperation, ValueError):
        return ZERO


def _f(v: Decimal) -> float:
    return float(v.quantize(CENT, rounding=ROUND_HALF_UP))


def _pct(num: Decimal, den: Decimal) -> Optional[float]:
    if den <= 0:
        return None
    return float((num / den * 100).quantize(CENT, rounding=ROUND_HALF_UP))


def _day(v: Any) -> Optional[date]:
    if v is None:
        return None
    return v.date() if isinstance(v, datetime) else v


def view_scope(db: Session, cu: User) -> str:
    if not user_has_permission(db, cu, "opportunities.view"):
        return "none"
    from app.utils.data_scope import get_module_data_scope
    return get_module_data_scope(db, cu, "opportunity")


def _team_ids(db: Session, cu: User, scope: str) -> Optional[set[int]]:
    """None = every user (scope all)."""
    if scope == "all":
        return None
    if scope == "team":
        from app.utils.data_scope import get_team_user_ids
        return set(get_team_user_ids(db, int(cu.id)))
    if scope == "own":
        return {int(cu.id)}
    return set()


def _quotas(db: Session, p: Period, user_ids: Optional[set[int]]) -> dict[int, Decimal]:
    """Sum of each user's quota for the months in the period (one query)."""
    months: list[tuple[int, int]] = []
    d = date(p.start.year, p.start.month, 1)
    while d <= p.end:
        months.append((d.year, d.month))
        d = _add_months(d, 1)
    keys = [f"{y}-{m:02d}" for y, m in months] + sorted({str(y) for y, _ in months})
    q = db.query(KAMTarget.id, KAMTarget.user_id, KAMTarget.period, KAMTarget.sales_target, KAMTarget.revenue_target).filter(KAMTarget.period.in_(keys))
    if user_ids is not None:
        if not user_ids:
            return {}
        q = q.filter(KAMTarget.user_id.in_(list(user_ids)))
    best: dict[tuple[int, str], tuple[int, Decimal]] = {}
    for r in q.all():
        amt = _d(r.sales_target) if r.sales_target not in (None, 0) else _d(r.revenue_target)
        k = (int(r.user_id), str(r.period))
        if k not in best or r.id > best[k][0]:                 # duplicates: the latest row wins
            best[k] = (r.id, amt)
    out: dict[int, Decimal] = defaultdict(lambda: ZERO)
    for uid in {u for u, _ in best}:
        for y, m in months:
            mk = best.get((uid, f"{y}-{m:02d}"))
            if mk is not None:
                out[uid] += mk[1]
            else:
                yk = best.get((uid, str(y)))
                if yk is not None:
                    out[uid] += yk[1] / 12
    return dict(out)


def compute(db: Session, cu: User, p: Period, cfg: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    from app.services import deal_service as DS
    cfg = cfg or config(db)
    scope = view_scope(db, cu)
    commit_min, best_min = Decimal(cfg["commit_min"]), Decimal(cfg["best_min"])
    today = today_ist()
    current = p.start <= today <= p.end
    agg: dict[int, dict[str, Decimal]] = defaultdict(lambda: {"cl": ZERO, "cm": ZERO, "bc": ZERO, "pp": ZERO})
    deals_counted = 0
    if scope != "none":
        DS.ensure_schema(db)
        pipes = DS.pipelines(db)
        leads = (DS.deal_query(db, cu).options(load_only(
            Lead.id, Lead.status, Lead.assigned_to, Lead.created_by, Lead.est_value, Lead.conversion_target,
            Lead.opportunity_created_at, Lead.created_at, Lead.updated_at, Lead.converted_at)).all())
        profiles, st = DS.sync(db, leads, pipes)
        for l in leads:
            info = st.get(l.id)
            if not info:
                continue
            kind, prob = info["stage"]["kind"], Decimal(int(info["stage"].get("prob") or 0))
            owner = l.assigned_to or l.created_by
            if not owner:
                continue
            v = _d(l.est_value)
            prof: Optional[DealProfile] = profiles.get(l.id)
            if kind == "won":
                won = _day(l.converted_at) or _day(prof.stage_entered_at if prof else None) or (prof.close_date if prof else None) or _day(l.updated_at)
                if won and p.start <= won <= p.end:
                    agg[int(owner)]["cl"] += v
                    deals_counted += 1
            elif kind == "open":
                cd = prof.close_date if prof else None
                if (cd is not None and p.start <= cd <= p.end) or (current and (cd is None or cd < today)):
                    b = "cm" if prob >= commit_min else "bc" if prob >= best_min else "pp"
                    agg[int(owner)][b] += v
                    deals_counted += 1

    team = _team_ids(db, cu, scope)
    quotas = _quotas(db, p, team) if scope != "none" else {}
    rep_ids = set(agg) | {u for u, q in quotas.items() if q > 0}
    if team is not None:
        rep_ids &= team
    users = {u.id: u for u in db.query(User.id, User.full_name, User.is_active).filter(User.id.in_(list(rep_ids))).all()} if rep_ids else {}
    adjs = {a.rep_user_id: _d(a.amount) for a in db.query(ForecastAdjustment.rep_user_id, ForecastAdjustment.amount)
            .filter(ForecastAdjustment.period_key == p.key, ForecastAdjustment.rep_user_id.in_(list(rep_ids))).all()} if rep_ids else {}
    if not cfg["adjustments"]:
        adjs = {}

    can_adjust = bool(cfg["adjustments"]) and user_has_permission(db, cu, "forecasts.adjust") and scope in ("all", "team")
    locked = bool(cfg["lock"]) and p.start <= today
    rows = []
    T = {"q": ZERO, "cl": ZERO, "cm": ZERO, "bc": ZERO, "pp": ZERO, "adj": ZERO}
    for uid in rep_ids:
        u = users.get(uid)
        a = agg.get(uid, {"cl": ZERO, "cm": ZERO, "bc": ZERO, "pp": ZERO})
        q, adj = quotas.get(uid, ZERO), adjs.get(uid, ZERO)
        if u is None or (not u.is_active and not any(a.values()) and not adj):
            continue
        r = {"q": q, "cl": a["cl"], "cm": a["cm"], "bc": a["bc"], "pp": a["pp"], "adj": adj}
        for k in T:
            T[k] += r[k]
        rows.append({"rep_id": uid, "name": u.full_name or f"User #{uid}", "active": bool(u.is_active),
                     "quota": _f(q), "closed": _f(a["cl"]), "commit": _f(a["cm"]), "best_case": _f(a["bc"]), "pipeline": _f(a["pp"]),
                     "adjustment": _f(adj), "attainment": _pct(a["cl"] + a["cm"] + adj, q),
                     "editable": can_adjust and not locked and (scope == "all" or uid != cu.id)})
    rows.sort(key=lambda r: r["name"].lower())
    gap = max(ZERO, T["q"] - T["cl"] - T["cm"] - T["adj"])
    return {
        "period": _period_json(p),
        "kpis": {"quota": _f(T["q"]), "closed": _f(T["cl"]), "closed_pct": _pct(T["cl"], T["q"]), "commit": _f(T["cm"]),
                 "best_case": _f(T["bc"]), "pipeline": _f(T["pp"]), "adjustment": _f(T["adj"]), "gap": _f(gap)},
        "rows": rows,
        "composition": {"items": [{"l": "Closed", "v": _f(T["cl"])}, {"l": "Commit", "v": _f(T["cm"])},
                                  {"l": "Best case", "v": _f(T["bc"])}, {"l": "Pipeline", "v": _f(T["pp"])}],
                        "center": _pct(T["cl"] + T["cm"], T["q"])},
        "thresholds": {"commit": int(commit_min), "best": int(best_min)},
        "scope": scope, "deals": deals_counted, "locked": locked,
        "can": {"adjust": can_adjust and not locked, "submit": user_has_permission(db, cu, "forecasts.submit") and scope != "none",
                "adjustments_enabled": bool(cfg["adjustments"]), "configure": user_has_permission(db, cu, "settings.manage")},
        "_totals": T,
    }


def public(res: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in res.items() if not k.startswith("_")}


def latest_submission(db: Session, cu: User, period_key: str) -> Optional[dict[str, Any]]:
    s = (db.query(ForecastSubmission).filter(ForecastSubmission.period_key == period_key, ForecastSubmission.submitted_by == cu.id)
         .order_by(ForecastSubmission.version.desc()).first())
    return _sub_json(s) if s else None


def _sub_json(s: ForecastSubmission) -> dict[str, Any]:
    return {"id": s.id, "period": s.period_key, "period_label": s.period_label, "version": s.version, "status": s.status,
            "submitted_by": s.submitted_by_name, "submitted_by_id": s.submitted_by, "submitted_at": s.submitted_at.isoformat() if s.submitted_at else None,
            "approver": s.approver_name, "approval_request_id": s.approval_request_id,
            "decided_at": s.decided_at.isoformat() if s.decided_at else None, "remarks": s.remarks, "totals": s.totals, "settings": s.settings}


# ─── manager adjustment ───────────────────────────────────────────────────────

def parse_amount(raw: Any) -> Decimal:
    if isinstance(raw, bool) or raw is None:
        raise HTTPException(422, "Enter a numeric adjustment")
    s = str(raw).strip().replace(",", "")
    if s == "":
        s = "0"
    try:
        v = Decimal(s)
    except InvalidOperation:
        raise HTTPException(422, "Enter a numeric adjustment")
    if not v.is_finite() or abs(v) > MAX_ADJ:
        raise HTTPException(422, "The adjustment is out of range")
    return v.quantize(CENT, rounding=ROUND_HALF_UP)


def set_adjustment(db: Session, cu: User, request: Optional[Request], p: Period, rep_id: int, raw: Any) -> dict[str, Any]:
    cfg = config(db)
    if not cfg["adjustments"]:
        raise HTTPException(403, "Manager adjustments are switched off in Forecast settings")
    if not user_has_permission(db, cu, "forecasts.adjust"):
        raise HTTPException(403, "You do not have permission to adjust forecasts")
    if cfg["lock"] and p.start <= today_ist():
        raise HTTPException(409, f"The forecast for {p.full} is locked – the period has started")
    scope = view_scope(db, cu)
    team = _team_ids(db, cu, scope)
    if scope not in ("all", "team") or (team is not None and rep_id not in team):
        raise HTTPException(403, "You can only adjust the forecast of reps in your team")
    if scope != "all" and rep_id == cu.id:
        raise HTTPException(403, "Your own forecast is adjusted by your manager")
    rep = db.query(User.id, User.full_name).filter(User.id == rep_id).first()
    if not rep:
        raise HTTPException(404, "Sales rep not found")
    amount = parse_amount(raw)
    row = (db.query(ForecastAdjustment).filter(ForecastAdjustment.period_key == p.key, ForecastAdjustment.rep_user_id == rep_id)
           .with_for_update().first())
    old = _d(row.amount) if row else ZERO
    if row is None:
        row = ForecastAdjustment(period_key=p.key, rep_user_id=rep_id, amount=amount, updated_by=cu.id)
        db.add(row)
    elif old != amount:
        row.amount, row.updated_by = amount, cu.id
    if old != amount:
        db.flush()
        from app.core.logging import log_audit_db
        log_audit_db(db, cu.id, MODULE, "adjustment_update", row.id, get_request_ip(request) if request else "",
                     description=f"Manager adjustment for {rep.full_name} · {p.full}: {_f(old):,.2f} → {_f(amount):,.2f}",
                     old_data={"period": p.key, "rep_id": rep_id, "amount": _f(old)},
                     new_data={"period": p.key, "rep_id": rep_id, "amount": _f(amount), "editor_id": cu.id, "editor": cu.full_name,
                               "at": now_ist().isoformat(timespec="seconds")},
                     record_name=f"{rep.full_name} · {p.label}")
    db.commit()
    return {"rep_id": rep_id, "old": _f(old), "amount": _f(amount), "changed": old != amount}


def adjustment_history(db: Session, cu: User, p: Period, rep_id: Optional[int], limit: int = 50) -> list[dict[str, Any]]:
    """Audit trail of the manager adjustments of a period (old → new, editor, time) for reps the caller can see."""
    from app.models.all_models import AuditLog
    scope = view_scope(db, cu)
    team = _team_ids(db, cu, scope)
    q = db.query(ForecastAdjustment.id).filter(ForecastAdjustment.period_key == p.key)
    if rep_id:
        q = q.filter(ForecastAdjustment.rep_user_id == rep_id)
    if team is not None:
        if not team:
            return []
        q = q.filter(ForecastAdjustment.rep_user_id.in_(list(team)))
    ids = [r.id for r in q.all()]
    if not ids:
        return []
    out = []
    for r in (db.query(AuditLog).filter(AuditLog.module == MODULE, AuditLog.action == "adjustment_update", AuditLog.record_id.in_(ids))
              .order_by(AuditLog.id.desc()).limit(limit).all()):
        nd = r.new_data if isinstance(r.new_data, dict) else {}
        od = r.old_data if isinstance(r.old_data, dict) else {}
        out.append({"rep_id": nd.get("rep_id"), "rep": r.record_name, "old": od.get("amount"), "new": nd.get("amount"), "editor": nd.get("editor"),
                    "editor_id": r.user_id, "at": nd.get("at") or (r.created_at.isoformat() if r.created_at else None), "description": r.description})
    return out


# ─── submit forecast ──────────────────────────────────────────────────────────

def _notify(db: Session, uid: Optional[int], title: str, msg: str, rid: int, action: str) -> None:
    if not uid:
        return
    try:
        from app.services.notification_service import upsert_notification
        upsert_notification(db, uid, title, msg, module=MODULE, record_id=rid, action=action, action_url="/forecasts", send_email=False)
    except Exception as exc:                       # notifications must never block the forecast itself
        logger.warning("forecast notification failed: %s", exc)


def submit(db: Session, cu: User, request: Request, p: Period) -> dict[str, Any]:
    if not user_has_permission(db, cu, "forecasts.submit"):
        raise HTTPException(403, "You do not have permission to submit forecasts")
    cfg = config(db)
    res = compute(db, cu, p, cfg)
    if res["scope"] == "none":
        raise HTTPException(403, "You do not have access to deals")
    if not res["rows"]:
        raise HTTPException(422, f"There is nothing to submit for {p.full} – no quotas or deals in this period")
    pending = (db.query(ForecastSubmission.id).filter(ForecastSubmission.period_key == p.key, ForecastSubmission.submitted_by == cu.id,
                                                      ForecastSubmission.status == "pending").first())
    if pending:
        raise HTTPException(409, f"Your forecast for {p.full} is already waiting for approval")
    version = (db.query(func.max(ForecastSubmission.version)).filter(ForecastSubmission.period_key == p.key,
                                                                    ForecastSubmission.submitted_by == cu.id).scalar() or 0) + 1
    k = res["kpis"]
    sub = ForecastSubmission(
        period_key=p.key, period_label=p.full, period_start=datetime.combine(p.start, datetime.min.time()),
        period_end=datetime.combine(p.end, datetime.min.time()), version=version, status="pending", submitted_by=cu.id,
        submitted_by_name=cu.full_name, submitted_at=now_ist(),
        totals={**k, "center": res["composition"]["center"], "reps": len(res["rows"]), "deals": res["deals"], "scope": res["scope"]},
        settings={"commit_min": cfg["commit_min"], "best_min": cfg["best_min"], "fy_start_month": cfg["fy_start_month"]})
    db.add(sub)
    db.flush()
    db.add_all([ForecastSubmissionLine(submission_id=sub.id, rep_user_id=r["rep_id"], rep_name=r["name"], quota=_d(r["quota"]), closed=_d(r["closed"]),
                                       commit_amount=_d(r["commit"]), best_case=_d(r["best_case"]), pipeline=_d(r["pipeline"]),
                                       adjustment=_d(r["adjustment"]), attainment=None if r["attainment"] is None else _d(r["attainment"])) for r in res["rows"]])
    from app.services.generic_approval_engine import create_generic_approval_request
    req = create_generic_approval_request(db, tenant_id=getattr(getattr(request.state, "tenant", None), "id", None), requester=cu,
                                          module_key=APPROVAL_MODULE, action_key=APPROVAL_ACTION, record_id=sub.id)
    sub.approval_request_id = req.id
    step = next((s for s in sorted(req.steps or [], key=lambda x: x.step_no) if s.step_no == req.current_step_no), None)
    approver = step.approver.full_name if step is not None and getattr(step, "approver", None) else None
    sub.approver_name = approver
    if (req.status or "").strip().lower() == "approved":
        sub.status, sub.decided_at = "approved", now_ist()
    from app.core.logging import log_audit_db
    log_audit_db(db, cu.id, MODULE, "submit", sub.id, get_request_ip(request),
                 description=f"Forecast {p.full} v{version} submitted" + (f" to {approver}" if approver else ""),
                 new_data={"period": p.key, "version": version, "status": sub.status, "approval_request_id": req.id, **k},
                 record_name=f"{p.full} v{version}")
    db.commit()
    if sub.status == "approved":
        msg = f"Forecast for {p.full} submitted and approved (v{version})"
    else:
        msg = f"Forecast submitted to {approver or 'the approver'} for {p.full}"
    return {"submission": _sub_json(sub), "message": msg}


def on_decision(db: Session, request_row, actor: User, remarks: str = "") -> None:
    """Approval engine callback (module "forecast", action "submit")."""
    sub = db.query(ForecastSubmission).filter(ForecastSubmission.id == request_row.record_id).first()
    if not sub or sub.status != "pending":
        return
    status = (request_row.status or "").strip().lower()
    if status in ("approved", "rejected"):
        sub.status, sub.decided_by, sub.decided_at, sub.remarks = status, actor.id, now_ist(), remarks or None
        from app.core.logging import log_audit_db
        log_audit_db(db, actor.id, MODULE, f"submission_{status}", sub.id, "",
                     description=f"Forecast {sub.period_label} v{sub.version} {status}" + (f" – {remarks}" if remarks else ""),
                     old_data={"status": "pending"}, new_data={"status": status, "remarks": remarks or None}, record_name=f"{sub.period_label} v{sub.version}")
        _notify(db, sub.submitted_by, f"Forecast {status}", f"Your forecast for {sub.period_label} (v{sub.version}) was {status} by {actor.full_name}"
                + (f": {remarks}" if remarks else "."), sub.id, status)
    else:                                            # moved to the next approval step – keep the current approver name
        step = next((s for s in sorted(request_row.steps or [], key=lambda x: x.step_no) if s.step_no == request_row.current_step_no), None)
        if step is not None and getattr(step, "approver", None):
            sub.approver_name = step.approver.full_name


def _sub_query(db: Session, cu: User):
    """Own submissions; approvers also see the ones routed to them; scope "all" sees every submission."""
    q = db.query(ForecastSubmission)
    if view_scope(db, cu) != "all":
        from app.models.all_models import ApprovalRequestStep
        mine = db.query(ApprovalRequestStep.approval_request_id).filter(ApprovalRequestStep.approver_user_id == cu.id)
        q = q.filter((ForecastSubmission.submitted_by == cu.id) | (ForecastSubmission.approval_request_id.in_(mine)))
    return q


def submissions(db: Session, cu: User, period_key: Optional[str], limit: int) -> list[dict[str, Any]]:
    q = _sub_query(db, cu)
    if period_key:
        q = q.filter(ForecastSubmission.period_key == period_key)
    return [_sub_json(s) for s in q.order_by(ForecastSubmission.submitted_at.desc(), ForecastSubmission.id.desc()).limit(limit).all()]


def submission_detail(db: Session, cu: User, sid: int) -> dict[str, Any]:
    sub = _sub_query(db, cu).filter(ForecastSubmission.id == sid).first()
    if not sub:
        raise HTTPException(404, "Forecast submission not found")
    s = _sub_json(sub)
    lines = db.query(ForecastSubmissionLine).filter(ForecastSubmissionLine.submission_id == sid).order_by(ForecastSubmissionLine.rep_name).all()
    s["lines"] = [{"rep_id": l.rep_user_id, "name": l.rep_name, "quota": _f(_d(l.quota)), "closed": _f(_d(l.closed)), "commit": _f(_d(l.commit_amount)),
                   "best_case": _f(_d(l.best_case)), "pipeline": _f(_d(l.pipeline)), "adjustment": _f(_d(l.adjustment)),
                   "attainment": float(l.attainment) if l.attainment is not None else None} for l in lines]
    return s
