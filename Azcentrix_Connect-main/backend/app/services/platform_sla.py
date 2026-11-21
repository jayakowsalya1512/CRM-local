"""SLA & customer satisfaction (Governance → SLA & CSAT) for Support Desk tickets.

Policies: one per plan (Plans & entitlements) – first-response and resolution targets in hours, coverage and channels.
Every change writes a new immutable version; a ticket keeps the version it was opened under, so later changes never
alter past compliance. Plans without a policy get one seeded from the prototype's tiers by plan:
    core ← Starter 24 h / 120 h, business hours, e-mail          standard ← Growth 8 / 72, business hours, e-mail + chat
    premium ← Enterprise 2 / 24, 24×7 for P1, e-mail/chat/phone  enterprise ← Group Enterprise 1 / 12, 24×7, all + manager
    any other plan ← Starter values (the most lenient tier) – all editable on the page.
Priorities: Critical = P1, High = P2, Medium and Low = P3 (Normal).
Deadlines: 24×7 coverage (or "24×7 for P1" on a P1 ticket) counts wall-clock hours; business-hours coverage counts only
the working time of the SLA calendar (working days, day start / end in IST, minus holidays).
A target is breached when it was met after its deadline, or is still unmet and the deadline has passed. A ticket counts
once in Breaches however many of its targets were missed. SLA met % = tickets that met both targets / tickets whose
outcome is known (both targets met, or at least one breached) – open tickets still within their deadlines are not counted.
Average first response and resolution are wall-clock elapsed times of tickets opened in the window.
Reopening a resolved ticket clears its resolution; the original resolution deadline still applies.
CSAT: one 1–5 rating per resolved ticket, from the requester or a tenant admin in the app, or from the rating link
e-mailed on resolution. Monthly averages use only the ratings given in that month; months without ratings have no value.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Optional

from sqlalchemy import and_, case, func, or_
from sqlalchemy.orm import Session

from app.database import master_engine
from app.models.platform_sla import (PlatformCannedResponse, PlatformSlaCalendar, PlatformSlaPolicy, PlatformSlaPolicyVersion, PlatformTicketCsat,
                                     PlatformTicketReply, PlatformTicketSla)
from app.models.tenant import Plan

IST = timedelta(hours=5, minutes=30)
COVERAGE = {"business": "Business hours", "24x7_p1": "24×7 for P1", "24x7": "24×7"}
CHANNELS = {"email": "Email", "chat": "Chat", "phone": "Phone", "manager": "Dedicated manager"}
PRIORITY_CODE = {"Critical": "P1", "High": "P2", "Medium": "P3", "Low": "P3"}
PRIORITY_LABEL = {"P1": "P1 – Critical", "P2": "P2 – High", "P3": "P3 – Normal"}
TIERS = {
    "starter": (24, 120, "business", ["email"]),
    "growth": (8, 72, "business", ["email", "chat"]),
    "enterprise": (2, 24, "24x7_p1", ["email", "chat", "phone"]),
    "group": (1, 12, "24x7", ["email", "chat", "phone", "manager"]),
}
PLAN_TIER = {"core": "starter", "standard": "growth", "premium": "enterprise", "enterprise": "group"}
MAX_FIRST_H, MAX_RESOLUTION_H = 168, 2160
CANNED = [  # prototype templates
    ("ack", "Acknowledge ticket", "Thanks for reaching out – we are on it."),
    ("logs", "Request logs", "Could you share the time and a screenshot?"),
    ("maint", "Maintenance notice", "A maintenance window is scheduled…"),
    ("resolved", "Resolved", "We have fixed this – please confirm."),
]
DEFAULT_DAYS = [1, 2, 3, 4, 5, 6]          # prototype working days Mon–Sat, 09:30–18:00
FIXED_HOLIDAYS = [("01-26", "Republic Day"), ("08-15", "Independence Day"), ("10-02", "Gandhi Jayanti"), ("12-25", "Christmas")]
CSAT_LINK_DAYS = 30
_ready: dict = {}


class SlaError(Exception):
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def ensure_schema() -> None:
    if _ready.get("schema"):
        return
    for model in (PlatformSlaPolicyVersion, PlatformSlaPolicy, PlatformSlaCalendar, PlatformTicketSla, PlatformTicketReply, PlatformTicketCsat,
                  PlatformCannedResponse):
        model.__table__.create(bind=master_engine, checkfirst=True)
    with master_engine.begin() as conn:
        if not conn.execute(PlatformCannedResponse.__table__.select().limit(1)).first():
            conn.execute(PlatformCannedResponse.__table__.insert(), [{"key": k, "title": t, "body": b, "sort": i, "updated_at": datetime.utcnow()}
                                                                     for i, (k, t, b) in enumerate(CANNED)])
        if not conn.execute(PlatformSlaCalendar.__table__.select().limit(1)).first():
            year = date.today().year
            conn.execute(PlatformSlaCalendar.__table__.insert(), {"id": 1, "days": DEFAULT_DAYS, "day_start": "09:30", "day_end": "18:00", "updated_at": datetime.utcnow(),
                                                                 "holidays": [{"date": f"{y}-{md}", "name": n} for y in (year, year + 1) for md, n in FIXED_HOLIDAYS]})
    _ready["schema"] = True


def _utc(v: Optional[datetime]) -> Optional[str]:
    return v.replace(microsecond=0).isoformat() + "Z" if v else None


def ist_month(at: datetime) -> date:
    local = at + IST
    return date(local.year, local.month, 1)


# ─── Policies ────────────────────────────────────────────────────────────────

def channels_label(channels: list[str]) -> str:
    s = set(channels)
    if {"email", "chat", "phone"} <= s:
        return "All + dedicated manager" if "manager" in s else "Email, chat, phone"
    parts = [CHANNELS[c] for c in CHANNELS if c in s]
    return ", ".join([parts[0]] + [p.lower() for p in parts[1:]]) if parts else "—"


def _hours(v) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.01"))


def _version_row(p: PlatformSlaPolicy | PlatformSlaPolicyVersion) -> dict:
    return {"first_response_h": float(p.first_response_h), "resolution_h": float(p.resolution_h), "coverage": p.coverage, "channels": list(p.channels)}


def ensure_policies(db: Session) -> dict[int, PlatformSlaPolicy]:
    """Current policy of every plan, seeding plans that have none (see module doc)."""
    ensure_schema()
    have = {p.plan_id: p for p in db.query(PlatformSlaPolicy).all()}
    missing = [p for p in db.query(Plan).all() if p.id not in have]
    for plan in missing:
        first, res, cov, ch = TIERS[PLAN_TIER.get((plan.slug or "").lower(), "starter")]
        v = PlatformSlaPolicyVersion(plan_id=plan.id, version=1, first_response_h=first, resolution_h=res, coverage=cov, channels=ch, created_by="seed",
                                     created_at=datetime.utcnow())
        db.add(v)
        db.flush()
        have[plan.id] = PlatformSlaPolicy(plan_id=plan.id, first_response_h=first, resolution_h=res, coverage=cov, channels=ch, version_id=v.id,
                                          updated_by="seed", updated_at=datetime.utcnow())
        db.add(have[plan.id])
    if missing:
        db.flush()
    return have


def policies(db: Session) -> list[dict]:
    pol = ensure_policies(db)
    plans = db.query(Plan).order_by(Plan.price_monthly, Plan.id).all()
    versions = dict(db.query(PlatformSlaPolicyVersion.id, PlatformSlaPolicyVersion.version).filter(
        PlatformSlaPolicyVersion.id.in_([p.version_id for p in pol.values()] or [0])).all())
    return [{"plan_id": pl.id, "plan": pl.name, "active": pl.is_active, **_version_row(pol[pl.id]), "coverage_label": COVERAGE[pol[pl.id].coverage],
             "channels_label": channels_label(pol[pl.id].channels), "version": versions.get(pol[pl.id].version_id), "updated_by": pol[pl.id].updated_by,
             "updated_at": _utc(pol[pl.id].updated_at)} for pl in plans]


def validate(first, resolution, coverage: str, channels: list[str]) -> tuple[Decimal, Decimal]:
    try:
        f, r = _hours(first), _hours(resolution)
    except (InvalidOperation, ValueError, TypeError):
        raise SlaError("Enter the targets in hours")
    if not (0 < f <= MAX_FIRST_H):
        raise SlaError(f"First response must be above 0 and at most {MAX_FIRST_H} h")
    if not (0 < r <= MAX_RESOLUTION_H):
        raise SlaError(f"Resolution must be above 0 and at most {MAX_RESOLUTION_H} h")
    if f > r:
        raise SlaError("First response can't be longer than resolution")
    if coverage not in COVERAGE:
        raise SlaError("Choose a coverage")
    if not channels or any(c not in CHANNELS for c in channels):
        raise SlaError("Choose at least one channel")
    return f, r


def update_policy(db: Session, plan_id: int, changes: dict, actor: str) -> tuple[dict, dict, Optional[int]]:
    """Apply changes; returns (before, after, new version number or None when nothing changed)."""
    pol = ensure_policies(db)
    p = pol.get(plan_id)
    if p is None:
        raise SlaError("Plan not found", 404)
    before = _version_row(p)
    after = {**before, **{k: v for k, v in changes.items() if v is not None}}
    after["channels"] = [c for c in CHANNELS if c in set(after["channels"])]
    f, r = validate(after["first_response_h"], after["resolution_h"], after["coverage"], after["channels"])
    after.update(first_response_h=float(f), resolution_h=float(r))
    if after == before:
        return before, after, None
    last = db.query(func.max(PlatformSlaPolicyVersion.version)).filter(PlatformSlaPolicyVersion.plan_id == plan_id).scalar() or 0
    v = PlatformSlaPolicyVersion(plan_id=plan_id, version=last + 1, first_response_h=f, resolution_h=r, coverage=after["coverage"], channels=after["channels"],
                                 created_by=actor, created_at=datetime.utcnow())
    db.add(v)
    db.flush()
    p.first_response_h, p.resolution_h, p.coverage, p.channels = f, r, after["coverage"], after["channels"]
    p.version_id, p.updated_by, p.updated_at = v.id, actor, datetime.utcnow()
    return before, after, v.version


# ─── Calendar and deadlines ──────────────────────────────────────────────────

def calendar(db: Session) -> PlatformSlaCalendar:
    ensure_schema()
    return db.get(PlatformSlaCalendar, 1)


def calendar_dict(c: PlatformSlaCalendar) -> dict:
    return {"days": c.days, "day_start": c.day_start, "day_end": c.day_end, "holidays": sorted(c.holidays, key=lambda h: h["date"]),
            "timezone": "Asia/Kolkata", "updated_by": c.updated_by, "updated_at": _utc(c.updated_at)}


def _hm(v: str) -> int:
    try:
        h, m = (int(x) for x in v.split(":"))
    except (ValueError, AttributeError):
        raise SlaError(f"“{v}” is not a time (HH:MM)")
    if not (0 <= h < 24 and 0 <= m < 60):
        raise SlaError(f"“{v}” is not a time (HH:MM)")
    return h * 60 + m


def update_calendar(db: Session, days: list[int], day_start: str, day_end: str, holidays: list[dict], actor: str) -> tuple[dict, dict]:
    c = calendar(db)
    before = calendar_dict(c)
    days = sorted({int(d) for d in days})
    if not days or any(d < 1 or d > 7 for d in days):
        raise SlaError("Choose at least one working day")
    if _hm(day_end) <= _hm(day_start):
        raise SlaError("The day must end after it starts")
    clean = {}
    for h in holidays:
        try:
            d = date.fromisoformat(str(h.get("date")))
        except ValueError:
            raise SlaError(f"“{h.get('date')}” is not a date")
        clean[d.isoformat()] = {"date": d.isoformat(), "name": (str(h.get("name") or "").strip() or "Holiday")[:80]}
    c.days, c.day_start, c.day_end, c.holidays = days, day_start, day_end, sorted(clean.values(), key=lambda x: x["date"])
    c.updated_by, c.updated_at = actor, datetime.utcnow()
    return before, calendar_dict(c)


def add_hours(start: datetime, hours: float, cal: Optional[dict], around_clock: bool) -> datetime:
    """Deadline ``hours`` after ``start`` (naive UTC): wall clock, or working time of ``cal`` (IST)."""
    if around_clock:
        return start + timedelta(hours=hours)
    begin, end = _hm(cal["day_start"]), _hm(cal["day_end"])
    days, holidays = set(cal["days"]), {h["date"] for h in cal["holidays"]}
    left = timedelta(hours=hours)
    cur = start + IST
    for _ in range(3700):    # ten years of days – a calendar always has working days, so this is only a guard
        d = cur.date()
        if d.isoweekday() in days and d.isoformat() not in holidays:
            ws = datetime.combine(d, datetime.min.time()) + timedelta(minutes=begin)
            we = datetime.combine(d, datetime.min.time()) + timedelta(minutes=end)
            if cur < ws:
                cur = ws
            if cur < we:
                if we - cur >= left:
                    return cur + left - IST
                left -= we - cur
        cur = datetime.combine(d + timedelta(days=1), datetime.min.time())
    raise SlaError("The SLA calendar has no working time", 409)


def around_clock(coverage: str, code: str) -> bool:
    return coverage == "24x7" or (coverage == "24x7_p1" and code == "P1")


# ─── Ticket lifecycle ────────────────────────────────────────────────────────

def start(db: Session, ticket, tenant) -> Optional[PlatformTicketSla]:
    """Open the SLA clock of a new ticket under its tenant's plan policy (none when the tenant has no plan)."""
    pol = ensure_policies(db).get(tenant.plan_id) if tenant.plan_id else None
    if pol is None:
        return None
    code = PRIORITY_CODE.get(ticket.priority, "P3")
    full = around_clock(pol.coverage, code)
    cal = None if full else calendar_dict(calendar(db))
    row = PlatformTicketSla(ticket_id=ticket.id, tenant_id=ticket.tenant_id, plan_id=tenant.plan_id, policy_version_id=pol.version_id, priority_code=code,
                            coverage="24x7" if full else "business", created_at=ticket.created_at,
                            first_response_due=add_hours(ticket.created_at, float(pol.first_response_h), cal, full),
                            resolution_due=add_hours(ticket.created_at, float(pol.resolution_h), cal, full))
    db.add(row)
    db.flush()
    return row


def first_response(db: Session, ticket, at: datetime) -> None:
    s = db.get(PlatformTicketSla, ticket.id)
    if s is not None and s.first_response_at is None:
        s.first_response_at, s.first_response_secs, s.first_breached = at, int((at - s.created_at).total_seconds()), at > s.first_response_due


def resolved(db: Session, ticket, at: datetime) -> Optional[str]:
    """Stop the resolution clock; returns a new CSAT rating-link token when the ticket isn't rated yet."""
    s = db.get(PlatformTicketSla, ticket.id)
    if s is None:
        return None   # opened before SLA tracking: no clock and no link to hold (rating stays available in the app)
    if s.first_response_at is None:      # resolving is a response too
        first_response(db, ticket, at)
    s.resolved_at, s.resolution_secs, s.resolution_breached = at, int((at - s.created_at).total_seconds()), at > s.resolution_due
    if db.query(PlatformTicketCsat.id).filter(PlatformTicketCsat.ticket_id == ticket.id).first() is not None:
        return None
    token = secrets.token_urlsafe(32)
    s.csat_token_hash, s.csat_token_expires = hashlib.sha256(token.encode()).hexdigest(), at + timedelta(days=CSAT_LINK_DAYS)
    return token


def reopened(db: Session, ticket) -> None:
    s = db.get(PlatformTicketSla, ticket.id)
    if s is not None:
        s.resolved_at = s.resolution_secs = s.resolution_breached = None
        s.csat_token_hash = s.csat_token_expires = None


def _target(at: Optional[datetime], due: datetime, now: datetime) -> dict:
    if at is not None:
        return {"due": _utc(due), "at": _utc(at), "state": "breached" if at > due else "met"}
    return {"due": _utc(due), "at": None, "state": "breached" if now > due else "running", "left_secs": int((due - now).total_seconds())}


def ticket_sla(db: Session, ticket_id: int, now: Optional[datetime] = None) -> Optional[dict]:
    now = now or datetime.utcnow()
    s = db.get(PlatformTicketSla, ticket_id)
    if s is None:
        return None
    v = db.get(PlatformSlaPolicyVersion, s.policy_version_id)
    return {"priority": PRIORITY_LABEL[s.priority_code], "coverage": COVERAGE[s.coverage], "policy": {"version": v.version, **_version_row(v)} if v else None,
            "first_response": _target(s.first_response_at, s.first_response_due, now), "resolution": _target(s.resolved_at, s.resolution_due, now)}


# ─── CSAT ────────────────────────────────────────────────────────────────────

def submit_csat(db: Session, ticket, rating, feedback: Optional[str], by: str, channel: str, now: Optional[datetime] = None) -> PlatformTicketCsat:
    now = now or datetime.utcnow()
    if ticket.status != "closed":
        raise SlaError("The ticket can be rated once it is resolved", 409)
    try:
        r = int(rating)
    except (TypeError, ValueError):
        raise SlaError("Rate from 1 to 5")
    if str(rating).strip() != str(r) or not 1 <= r <= 5:
        raise SlaError("Rate from 1 to 5")
    if db.query(PlatformTicketCsat.id).filter(PlatformTicketCsat.ticket_id == ticket.id).first():
        raise SlaError(f"{ticket.ref} has already been rated", 409)
    row = PlatformTicketCsat(ticket_id=ticket.id, tenant_id=ticket.tenant_id, rating=r, feedback=(feedback or "").strip()[:2000] or None,
                             submitted_by=(by or "")[:200] or None, channel=channel, submitted_at=now, month=ist_month(now))
    db.add(row)
    s = db.get(PlatformTicketSla, ticket.id)
    if s is not None:
        s.csat_token_hash = s.csat_token_expires = None     # a rating link works once
    db.flush()
    return row


def ticket_for_token(db: Session, token: str, now: Optional[datetime] = None):
    from app.models.platform_support import PlatformSupportTicket as Tk
    ensure_schema()
    now = now or datetime.utcnow()
    h = hashlib.sha256((token or "").encode()).hexdigest()
    s = db.query(PlatformTicketSla).filter(PlatformTicketSla.csat_token_hash == h).first()
    if s is None or (s.csat_token_expires and s.csat_token_expires < now):
        raise SlaError("This rating link is no longer valid – it was used already or has expired", 404)
    return db.get(Tk, s.ticket_id)


def csat_dict(c: Optional[PlatformTicketCsat]) -> Optional[dict]:
    return None if c is None else {"rating": c.rating, "feedback": c.feedback, "by": c.submitted_by, "channel": c.channel, "at": _utc(c.submitted_at)}


# ─── Reporting (grouped queries) ─────────────────────────────────────────────

def _breach_exprs(now: datetime):
    S = PlatformTicketSla
    first_b = or_(S.first_breached == True, and_(S.first_response_at.is_(None), S.first_response_due < now))  # noqa: E712
    res_b = or_(S.resolution_breached == True, and_(S.resolved_at.is_(None), S.resolution_due < now))         # noqa: E712
    met = and_(S.first_breached == False, S.resolution_breached == False)                                       # noqa: E712 – both set only once met
    return first_b, res_b, met


def _scoped(q, col, scope: Optional[set[int]]):
    return q if scope is None else q.filter(col.in_(list(scope) or [0]))


def _n(cond):
    return func.coalesce(func.sum(case((cond, 1), else_=0)), 0)


def kpis(db: Session, scope: Optional[set[int]], now: Optional[datetime] = None) -> dict:
    ensure_schema()
    now = now or datetime.utcnow()
    S, C = PlatformTicketSla, PlatformTicketCsat
    since = now - timedelta(days=30)
    first_b, res_b, met = _breach_exprs(now)
    breached = or_(first_b, res_b)
    row = _scoped(db.query(func.count(S.ticket_id), _n(met), _n(breached), _n(first_b), _n(res_b), func.avg(S.first_response_secs), func.avg(S.resolution_secs),
                           func.count(S.first_response_secs), func.count(S.resolution_secs)).filter(S.created_at >= since), S.tenant_id, scope).one()
    total, n_met, n_breach, n_first, n_res, avg_first, avg_res, n_avg_first, n_avg_res = row
    known = int(n_met) + int(n_breach)
    # weekly SLA met % for the sparkline: 7 weeks, oldest first
    week = case(*[(S.created_at >= now - timedelta(days=7 * (i + 1)), 6 - i) for i in range(7)], else_=-1)
    spark = [None] * 7
    for w, m, b in _scoped(db.query(week, _n(met), _n(breached)).filter(S.created_at >= now - timedelta(days=49)), S.tenant_id, scope).group_by(week).all():
        if 0 <= w <= 6 and (m + b):
            spark[w] = round(100 * m / (m + b), 1)
    cs = _scoped(db.query(func.avg(C.rating), func.count(C.id)).filter(C.submitted_at >= since), C.tenant_id, scope).one()
    return {"tickets": int(total), "sla_met": round(100 * int(n_met) / known, 1) if known else None, "met": int(n_met), "known": known, "sla_spark": spark,
            "avg_first_response_h": round(float(avg_first) / 3600, 1) if avg_first is not None else None, "first_responses": int(n_avg_first),
            "avg_resolution_h": round(float(avg_res) / 3600, 1) if avg_res is not None else None, "resolutions": int(n_avg_res),
            "csat": round(float(cs[0]), 1) if cs[0] is not None else None, "csat_responses": int(cs[1]),
            "breaches": int(n_breach), "first_breaches": int(n_first), "resolution_breaches": int(n_res)}


def breaches_by_priority(db: Session, scope: Optional[set[int]], now: Optional[datetime] = None) -> list[dict]:
    ensure_schema()
    now = now or datetime.utcnow()
    S = PlatformTicketSla
    first_b, res_b, _ = _breach_exprs(now)
    rows = {code: (int(b), int(f), int(r)) for code, b, f, r in _scoped(
        db.query(S.priority_code, _n(or_(first_b, res_b)), _n(first_b), _n(res_b)).filter(S.created_at >= now - timedelta(days=30)), S.tenant_id, scope)
        .group_by(S.priority_code).all()}
    return [{"code": c, "label": PRIORITY_LABEL[c], "breaches": rows.get(c, (0, 0, 0))[0], "first_response": rows.get(c, (0, 0, 0))[1],
             "resolution": rows.get(c, (0, 0, 0))[2]} for c in PRIORITY_LABEL]


def csat_trend(db: Session, scope: Optional[set[int]], now: Optional[datetime] = None, months: int = 6) -> dict:
    ensure_schema()
    now = now or datetime.utcnow()
    C = PlatformTicketCsat
    cur = ist_month(now)
    keys = []
    y, m = cur.year, cur.month
    for _ in range(months):
        keys.append(date(y, m, 1))
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    keys.reverse()
    found = {mo: (float(a), int(n)) for mo, a, n in _scoped(db.query(C.month, func.avg(C.rating), func.count(C.id)).filter(C.month >= keys[0]), C.tenant_id, scope)
             .group_by(C.month).all()}
    return {"labels": [k.strftime("%b") for k in keys], "months": [k.isoformat() for k in keys],
            "values": [round(found[k][0], 2) if k in found else None for k in keys], "responses": [found[k][1] if k in found else 0 for k in keys]}


def canned(db: Session) -> list[dict]:
    ensure_schema()
    return [{"id": c.id, "key": c.key, "title": c.title, "body": c.body} for c in db.query(PlatformCannedResponse).order_by(PlatformCannedResponse.sort, PlatformCannedResponse.id).all()]


def ticket_slas(db: Session, ticket_ids: list[int], now: Optional[datetime] = None) -> dict[int, dict]:
    """Compact SLA state of many tickets (Support Desk list) in one query."""
    now = now or datetime.utcnow()
    out = {}
    for s in db.query(PlatformTicketSla).filter(PlatformTicketSla.ticket_id.in_(ticket_ids or [0])).all():
        f, r = _target(s.first_response_at, s.first_response_due, now), _target(s.resolved_at, s.resolution_due, now)
        nxt = f if f["state"] == "running" else r if r["state"] == "running" else None
        out[s.ticket_id] = {"code": s.priority_code, "breached": "breached" in (f["state"], r["state"]), "next_due": nxt["due"] if nxt else None,
                            "next": "first response" if nxt is f else "resolution" if nxt is r else None}
    return out

