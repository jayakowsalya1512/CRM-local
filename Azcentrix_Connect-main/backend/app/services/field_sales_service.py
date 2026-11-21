"""Field Sales 360 (prototype v17 · Finance & Field → Field Sales 360) – team overview, KAM 360, visits & check-ins,
customer coverage, activity analytics, targets and territories, computed from the tenant's real records.

Sources (nothing is generated or estimated):
* KAMs            – active users with a sales (KAM) role inside the caller's KAM Data Visibility (Roles & Security →
                    kam data_scope: all / team / own), same rule as the KAM module (kam_router._get_team_uids).
* Activities      – kam_activities. "Recorded" = status Completed / In Progress / Reopened (planned, postponed and
                    cancelled entries are not activities that happened). Types are grouped into the prototype's six:
                    Site Visit · Call (Phone / Video) · Meeting (In Person Meet) · Email · Demo · Follow-up.
* Outcome         – field_visits.outcome_rating, else the activity's outcome text when it starts with one of
                    Positive / Neutral / Negative / Follow-up; anything else is left unclassified.
* Check-in / GPS  – field_visits (check-in / check-out captured with the user's permission from Field Sales 360),
                    else the coordinates the KAM module stored with the activity / its kam_log events.
* Duration        – check-out − check-in (field_visits), else the execution cycle's actual duration (started → completed).
                    Typed-in planned durations are never used as a measured visit time.
* Distance        – distance recorded at check-out + kam_travel_expenses.distance_km of the visit.
* Customers       – Customers & Contacts with the caller's customer Data Visibility; KAM = own or inherited KAM, tier /
                    FY revenue / health from the Customer 360 service.
* Deals           – Deals module (deal_service): stage kind open / won / lost, value = deal value. Achieved = closed-won
                    value with the win date in the fiscal year (same rule as Forecasts).
* Targets         – field_sales_targets (Targets tab), else the configured kam_targets quotas for the fiscal year (the
                    Forecasts quota rule), else the user's master target.
"""
from __future__ import annotations

import logging
import threading
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Optional

from fastapi import HTTPException, Request
from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from app.core.timezone import now_ist, today_ist
from app.dependencies import get_request_ip, user_has_permission
from app.models.all_models import (Customer, CustomerContact, KAMActivity, KAMActivityExecutionCycle, KAMLog,
                                   KAMTravelExpense, Lead, Quotation, Setting, Tender, User, WorkOrder)
from app.models.field_sales import FIELD_SALES_TABLES, OUTCOMES, FieldSalesTarget, FieldSalesTargetHistory, FieldVisit

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_PURGED: dict[str, date] = {}
_LOCK = threading.Lock()

TYPES = ["Site Visit", "Call", "Meeting", "Email", "Demo", "Follow-up"]
TYPE_GROUP = {"Site Visit": "Site Visit", "Phone Call": "Call", "Video Call": "Call", "Daily Call": "Call", "Call": "Call",
              "In Person Meet": "Meeting", "Meeting": "Meeting", "Email": "Email", "Demo": "Demo",
              "Follow Up": "Follow-up", "Follow-up": "Follow-up"}
TYPE_TO_DB = {"Site Visit": "Site Visit", "Call": "Phone Call", "Meeting": "In Person Meet", "Email": "Email",
              "Demo": "Demo", "Follow-up": "Follow Up"}
DONE = ("Completed", "In Progress", "Reopened")
WINDOW = 14
GPS_MAX_ACCURACY_M = 200          # a fix less precise than this is stored but not counted as verified

# Settings (tenant settings table): visit policy per tier and location retention
SETTING_KEYS = {"A": ("field_sales_visit_days_tier_a", 14), "B": ("field_sales_visit_days_tier_b", 30),
                "C": ("field_sales_visit_days_tier_c", 60), "retention": ("field_sales_location_retention_days", 365)}

# Reference coordinates (city / state centre) used to place a customer's city on the map when the visit has no GPS fix.
# Unknown places are not plotted.
CITY_COORDS: dict[str, tuple[float, float]] = {
    "chennai": (13.08, 80.27), "coimbatore": (11.0, 76.96), "madurai": (9.93, 78.12), "tiruchirappalli": (10.79, 78.7),
    "trichy": (10.79, 78.7), "salem": (11.66, 78.15), "erode": (11.34, 77.72), "tirunelveli": (8.71, 77.76),
    "vellore": (12.92, 79.13), "thoothukudi": (8.76, 78.13), "tiruppur": (11.11, 77.34), "hosur": (12.74, 77.83),
    "kanchipuram": (12.83, 79.7), "thanjavur": (10.79, 79.14), "nagercoil": (8.18, 77.41), "puducherry": (11.94, 79.81),
    "pondicherry": (11.94, 79.81), "bengaluru": (12.97, 77.59), "bangalore": (12.97, 77.59), "mysuru": (12.3, 76.64),
    "mysore": (12.3, 76.64), "mangaluru": (12.91, 74.86), "mangalore": (12.91, 74.86), "hubballi": (15.36, 75.12),
    "hubli": (15.36, 75.12), "belagavi": (15.85, 74.5), "kochi": (9.93, 76.26), "cochin": (9.93, 76.26),
    "ernakulam": (9.98, 76.28), "thiruvananthapuram": (8.52, 76.94), "trivandrum": (8.52, 76.94), "kozhikode": (11.26, 75.78),
    "thrissur": (10.53, 76.21), "hyderabad": (17.38, 78.48), "secunderabad": (17.44, 78.5), "warangal": (17.97, 79.59),
    "visakhapatnam": (17.69, 83.22), "vijayawada": (16.51, 80.65), "guntur": (16.31, 80.44), "tirupati": (13.63, 79.42),
    "nellore": (14.44, 79.99), "mumbai": (19.07, 72.87), "navi mumbai": (19.03, 73.03), "thane": (19.22, 72.98),
    "pune": (18.52, 73.86), "nagpur": (21.15, 79.09), "nashik": (19.99, 73.79), "aurangabad": (19.88, 75.34),
    "ahmedabad": (23.02, 72.57), "surat": (21.17, 72.83), "vadodara": (22.31, 73.18), "rajkot": (22.3, 70.8),
    "gandhinagar": (23.22, 72.65), "new delhi": (28.61, 77.2), "delhi": (28.61, 77.2), "gurugram": (28.46, 77.03),
    "gurgaon": (28.46, 77.03), "noida": (28.54, 77.39), "faridabad": (28.41, 77.32), "ghaziabad": (28.67, 77.45),
    "jaipur": (26.91, 75.79), "jodhpur": (26.24, 73.02), "udaipur": (24.58, 73.71), "kota": (25.21, 75.86),
    "lucknow": (26.85, 80.95), "kanpur": (26.45, 80.33), "varanasi": (25.32, 82.97), "agra": (27.18, 78.01),
    "prayagraj": (25.44, 81.85), "allahabad": (25.44, 81.85), "chandigarh": (30.73, 76.78), "ludhiana": (30.9, 75.86),
    "amritsar": (31.63, 74.87), "dehradun": (30.32, 78.03), "shimla": (31.1, 77.17), "jammu": (32.73, 74.86),
    "srinagar": (34.08, 74.8), "kolkata": (22.57, 88.36), "howrah": (22.59, 88.31), "durgapur": (23.52, 87.31),
    "bhubaneswar": (20.3, 85.82), "cuttack": (20.46, 85.88), "rourkela": (22.26, 84.85), "patna": (25.59, 85.14),
    "ranchi": (23.34, 85.31), "jamshedpur": (22.8, 86.2), "dhanbad": (23.8, 86.43), "raipur": (21.25, 81.63),
    "bhilai": (21.21, 81.38), "bhopal": (23.26, 77.41), "indore": (22.72, 75.86), "gwalior": (26.22, 78.18),
    "jabalpur": (23.18, 79.99), "guwahati": (26.14, 91.74), "shillong": (25.58, 91.89), "imphal": (24.82, 93.94),
    "agartala": (23.83, 91.29), "aizawl": (23.73, 92.72), "kohima": (25.67, 94.11), "itanagar": (27.08, 93.61),
    "gangtok": (27.33, 88.61), "panaji": (15.49, 73.83), "goa": (15.49, 73.83), "port blair": (11.62, 92.73),
}
STATE_COORDS: dict[str, tuple[float, float]] = {
    "tamil nadu": (11.13, 78.66), "kerala": (10.85, 76.27), "karnataka": (15.32, 75.71), "andhra pradesh": (15.91, 79.74),
    "telangana": (18.11, 79.02), "maharashtra": (19.75, 75.71), "gujarat": (22.26, 71.19), "goa": (15.3, 74.12),
    "rajasthan": (27.02, 74.22), "madhya pradesh": (22.97, 78.66), "chhattisgarh": (21.28, 81.87), "uttar pradesh": (26.85, 80.95),
    "delhi": (28.61, 77.2), "haryana": (29.06, 76.09), "punjab": (31.15, 75.34), "himachal pradesh": (31.1, 77.17),
    "uttarakhand": (30.07, 79.02), "jammu and kashmir": (33.78, 76.58), "bihar": (25.1, 85.31), "jharkhand": (23.61, 85.28),
    "west bengal": (22.99, 87.85), "odisha": (20.95, 85.1), "assam": (26.2, 92.94), "meghalaya": (25.47, 91.37),
    "manipur": (24.66, 93.91), "tripura": (23.94, 91.99), "mizoram": (23.16, 92.94), "nagaland": (26.16, 94.56),
    "arunachal pradesh": (28.22, 94.73), "sikkim": (27.53, 88.51), "puducherry": (11.94, 79.81), "chandigarh": (30.73, 76.78),
}


# ─── schema / settings ────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug not in _READY:
        with _LOCK:
            if slug not in _READY:
                bind = db.get_bind()
                for t in FIELD_SALES_TABLES:
                    t.create(bind=bind, checkfirst=True)
                db.commit()
                _READY.add(slug)
    if _PURGED.get(slug) != today_ist():
        _PURGED[slug] = today_ist()
        purge_locations(db)


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
            logger.warning("field sales schema: tenant %s unavailable: %s", slug, exc)
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
        except Exception as exc:
            logger.warning("field sales schema for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()


def settings(db: Session) -> dict[str, int]:
    keys = [k for k, _ in SETTING_KEYS.values()] + ["fiscal_year_start"]
    rows = {s.key: (s.value or "").strip() for s in db.query(Setting.key, Setting.value).filter(Setting.key.in_(keys)).all()}
    out: dict[str, int] = {}
    for name, (key, default) in SETTING_KEYS.items():
        try:
            v = int(float(rows.get(key) or default))
            out[name] = v if 1 <= v <= 3650 else default
        except ValueError:
            out[name] = default
    try:
        m0 = int(rows.get("fiscal_year_start") or 4)
    except ValueError:
        m0 = 4
    out["fy_start_month"] = m0 if 1 <= m0 <= 12 else 4
    return out


def purge_locations(db: Session) -> None:
    """Retention: drop raw check-in / check-out coordinates older than the configured period (verification result kept)."""
    try:
        days = settings(db)["retention"]
        cutoff = now_ist() - timedelta(days=days)
        db.query(FieldVisit).filter(FieldVisit.location_purged_at.is_(None), FieldVisit.check_in_at < cutoff,
                                    or_(FieldVisit.check_in_lat.isnot(None), FieldVisit.check_out_lat.isnot(None))).update(
            {FieldVisit.check_in_lat: None, FieldVisit.check_in_lng: None, FieldVisit.check_out_lat: None,
             FieldVisit.check_out_lng: None, FieldVisit.location_purged_at: now_ist()}, synchronize_session=False)
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning("field sales location purge skipped: %s", exc)


# ─── small helpers ────────────────────────────────────────────────────────────

def f(v: Any) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError, InvalidOperation):
        return 0.0


def _day(v: Any) -> Optional[date]:
    if v is None:
        return None
    return v.date() if isinstance(v, datetime) else v


def iso(v: Any) -> Optional[str]:
    d = _day(v)
    return d.isoformat() if d else None


def hhmm(v: Any) -> Optional[str]:
    if v is None:
        return None
    if isinstance(v, timedelta):                       # MySQL TIME may come back as timedelta
        s = int(v.total_seconds())
        return f"{s // 3600:02d}:{(s % 3600) // 60:02d}"
    try:
        return v.strftime("%H:%M")
    except AttributeError:
        return str(v)[:5]


def pct(a: float, b: float) -> int:
    return round(a / b * 100) if b else 0


def rating_of(text_: Optional[str]) -> Optional[str]:
    t = (text_ or "").strip().lower()
    for o in OUTCOMES:
        if t.startswith(o.lower()) or (o == "Follow-up" and t.startswith("follow")):
            return o
    return None


def window(today: Optional[date] = None) -> list[date]:
    t = today or today_ist()
    return [t - timedelta(days=WINDOW - 1 - i) for i in range(WINDOW)]


def fiscal_year(db: Session, cfg: Optional[dict] = None) -> dict[str, Any]:
    cfg = cfg or settings(db)
    m0, t = cfg["fy_start_month"], today_ist()
    y = t.year if t.month >= m0 else t.year - 1
    start = date(y, m0, 1)
    end = (date(y + 1, m0, 1) if m0 > 1 else date(y + 1, 1, 1)) - timedelta(days=1)
    total = (end - start).days + 1
    elapsed = min(total, (t - start).days + 1)
    label = f"FY {y}" if m0 == 1 else f"FY {y}-{str(y + 1)[2:]}"
    return {"start": start, "end": end, "label": label, "elapsed_pct": round(elapsed / total * 100, 1)}


def coord(city: Optional[str], state: Optional[str]) -> Optional[tuple[float, float]]:
    c = (city or "").strip().lower()
    if c in CITY_COORDS:
        return CITY_COORDS[c]
    s = (state or "").strip().lower()
    return STATE_COORDS.get(s)


# ─── scope: KAMs, customers, deals ────────────────────────────────────────────

def scope_uids(db: Session, cu: User) -> list[int]:
    from app.routers.kam_router import _get_team_uids
    return [int(u) for u in (_get_team_uids(cu, db) or []) if u]


def kam_users(db: Session, cu: User) -> list[dict[str, Any]]:
    """Active KAM users the caller may see (Users & Teams), with manager / region / branch."""
    from app.routers.kam_router import _is_kam_sales_role
    uids = scope_uids(db, cu)
    if not uids:
        return []
    rows = db.query(User).filter(User.id.in_(uids), User.is_active == True).order_by(User.full_name).all()
    kams = [u for u in rows if _is_kam_sales_role(u.role)]
    if not kams:
        kams = [u for u in rows if u.id == cu.id]
    mgr_ids = {u.reporting_manager_id for u in kams if u.reporting_manager_id}
    mgr = {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(mgr_ids)).all()} if mgr_ids else {}
    return [{"id": u.id, "name": u.full_name, "role": u.role, "designation": u.designation or "", "department": u.department or "",
             "region": u.region or "", "branch": u.branch or "", "manager": mgr.get(u.reporting_manager_id, ""),
             "active": bool(u.is_active)} for u in kams]


def require_kam(db: Session, cu: User, uid: int) -> None:
    """A KAM id from the client is honoured only inside the caller's KAM Data Visibility (no frontend trust)."""
    if int(uid) not in set(scope_uids(db, cu)):
        raise HTTPException(403, "You are not authorised to view this employee's records")


def customers(db: Session, cu: User, kam_ids: Iterable[int]) -> list[dict[str, Any]]:
    """Customers visible to the caller whose (own or inherited) KAM is one of kam_ids."""
    from app.services import customer360_service as S
    if not user_has_permission(db, cu, "customers.view"):
        return []
    from app.routers.customer_router import _apply_customer_data_scope
    S.ensure_schema(db)
    ks = {int(k) for k in kam_ids}
    rows = _apply_customer_data_scope(db, db.query(Customer), cu).filter(Customer.is_deleted == False).all()
    if not rows:
        return []
    fam, P = S.Family(db), S.profiles(db)
    picked = []
    for c in rows:
        k = fam.kam(c.id, P)[0]
        if k and int(k) in ks:
            picked.append((c, int(k)))
    if not picked:
        return []
    M = S.account_metrics(db, {c.id for c, _ in picked})
    out = []
    for c, k in picked:
        m = S.metrics_for(M, c.id)
        out.append({"id": c.id, "name": c.customer_name, "kam_id": k, "tier": S.TIER_OF.get(c.account_potential or "Medium", "B"),
                    "revenue": round(m["fy"], 2), "health": int(m["health"]), "city": (c.billing_city or "").strip(),
                    "state": (c.billing_state or "").strip()})
    return out


def deals(db: Session, cu: User, kam_ids: Iterable[int]) -> list[dict[str, Any]]:
    """Deals owned by the KAMs that the caller may see in the Deals module (opportunities.view + its data scope)."""
    from app.services import deal_service as DS
    ks = [int(k) for k in kam_ids]
    if not ks:
        return []
    DS.ensure_schema(db)
    pipes = DS.pipelines(db)
    leads = DS.deal_query(db, cu).filter(Lead.assigned_to.in_(ks)).all()
    if not leads:
        return []
    profiles, st = DS.sync(db, leads, pipes)
    extras = DS._row_extras(db, leads)
    out = []
    for l in leads:
        info = st.get(l.id)
        if not info:
            continue
        p, s, prof = info["pipe"], info["stage"], profiles.get(l.id)
        won_on = None
        if s["kind"] == "won":
            won_on = _day(l.converted_at) or _day(prof.stage_entered_at if prof else None) or (prof.close_date if prof else None) or _day(l.updated_at)
        out.append({"id": l.id, "name": l.lead_title or "", "owner_id": int(l.assigned_to), "value": f(l.est_value),
                    "stage": s["name"], "kind": s["kind"], "won_on": won_on, "customer": l.customer_name or "",
                    "jid": f"J-{l.id:04d}", "journey": DS.journey_track(l, p, s, extras.get(l.id, {}))})
    return out


# ─── activities ───────────────────────────────────────────────────────────────

def activities(db: Session, uids: Iterable[int], d_from: Optional[date] = None, d_to: Optional[date] = None,
               statuses: Optional[tuple] = DONE, types: Optional[list[str]] = None) -> list[dict[str, Any]]:
    ids = [int(u) for u in uids]
    if not ids:
        return []
    q = db.query(KAMActivity.id, KAMActivity.user_id, KAMActivity.activity_type, KAMActivity.customer_id,
                 KAMActivity.activity_date, KAMActivity.start_time, KAMActivity.subject, KAMActivity.description,
                 KAMActivity.outcome, KAMActivity.status, KAMActivity.location, KAMActivity.latitude, KAMActivity.longitude,
                 KAMActivity.created_at).filter(KAMActivity.user_id.in_(ids))
    if d_from:
        q = q.filter(KAMActivity.activity_date >= d_from)
    if d_to:
        q = q.filter(KAMActivity.activity_date <= d_to)
    if statuses:
        q = q.filter(KAMActivity.status.in_(statuses))
    if types:
        q = q.filter(KAMActivity.activity_type.in_([k for k, g in TYPE_GROUP.items() if g in types]))
    rows = q.order_by(KAMActivity.activity_date.desc(), KAMActivity.start_time.desc(), KAMActivity.id.desc()).all()
    side = {v.activity_id: v for v in db.query(FieldVisit).filter(FieldVisit.activity_id.in_([r.id for r in rows]))} if rows else {}
    out = []
    for r in rows:
        v = side.get(r.id)
        out.append({"id": r.id, "uid": int(r.user_id), "type": TYPE_GROUP.get(r.activity_type or "", "Call" if (r.activity_type or "").endswith("Call") else "Meeting"),
                    "raw_type": r.activity_type, "customer_id": r.customer_id, "date": _day(r.activity_date), "time": hhmm(r.start_time),
                    "subject": r.subject or "", "description": r.description or "", "outcome_text": r.outcome or "",
                    "outcome": (v.outcome_rating if v and v.outcome_rating else rating_of(r.outcome)), "status": r.status,
                    "location": r.location or "", "lat": r.latitude, "lng": r.longitude, "created_at": r.created_at, "visit": v})
    return out


def visit_details(db: Session, acts: list[dict[str, Any]]) -> None:
    """Adds check-in time, duration, GPS state / point, distance and planned flag to site-visit rows (batched)."""
    ids = [a["id"] for a in acts]
    if not ids:
        return
    cycles: dict[int, Any] = {}
    for c in db.query(KAMActivityExecutionCycle.activity_id, KAMActivityExecutionCycle.started_at, KAMActivityExecutionCycle.actual_duration_minutes,
                      KAMActivityExecutionCycle.cycle_no).filter(KAMActivityExecutionCycle.activity_id.in_(ids)).order_by(KAMActivityExecutionCycle.cycle_no).all():
        cycles[c.activity_id] = c
    gps: dict[int, Any] = {}
    created_planned: dict[int, bool] = {}
    for g in db.query(KAMLog.activity_id, KAMLog.latitude, KAMLog.longitude, KAMLog.is_mock_location, KAMLog.accuracy_meters,
                      KAMLog.event_type, KAMLog.new_status).filter(KAMLog.activity_id.in_(ids)).order_by(KAMLog.event_at, KAMLog.id).all():
        if g.event_type == "ACTIVITY_CREATED":
            created_planned[g.activity_id] = g.new_status == "Planned"
        if g.latitude is not None and g.longitude is not None and not g.is_mock_location and g.activity_id not in gps:
            if g.accuracy_meters is None or f(g.accuracy_meters) <= GPS_MAX_ACCURACY_M:
                gps[g.activity_id] = (float(g.latitude), float(g.longitude))
    dist: dict[int, float] = defaultdict(float)
    has_dist: set[int] = set()
    for e in db.query(KAMTravelExpense.activity_id, KAMTravelExpense.distance_km).filter(KAMTravelExpense.activity_id.in_(ids), KAMTravelExpense.distance_km.isnot(None)).all():
        dist[e.activity_id] += f(e.distance_km)
        has_dist.add(e.activity_id)
    for a in acts:
        v: Optional[FieldVisit] = a.get("visit")
        c = cycles.get(a["id"])
        a["check_in"] = hhmm(v.check_in_at) if v and v.check_in_at else hhmm(c.started_at) if c and c.started_at else a["time"]
        a["checked_in"] = bool((v and v.check_in_at) or (c and c.started_at))
        if v and v.check_in_at and v.check_out_at:
            a["duration"] = max(0, int((v.check_out_at - v.check_in_at).total_seconds() // 60))
        elif c and c.actual_duration_minutes is not None:
            a["duration"] = int(c.actual_duration_minutes)
        else:
            a["duration"] = None
        point = None
        if v and v.gps_status:
            a["gps"] = v.gps_status
            if v.check_in_lat is not None and v.check_in_lng is not None and v.gps_status == "verified":
                point = (float(v.check_in_lat), float(v.check_in_lng))
        elif a["id"] in gps:
            a["gps"], point = "verified", gps[a["id"]]
        elif a["lat"] is not None and a["lng"] is not None:
            a["gps"], point = "verified", (float(a["lat"]), float(a["lng"]))
        else:
            a["gps"] = "manual"
        a["point"] = point
        d = (f(v.distance_km) if v and v.distance_km is not None else 0.0) + dist.get(a["id"], 0.0)
        a["distance"] = d if (v and v.distance_km is not None) or a["id"] in has_dist else None
        if v and v.planned is not None:
            a["planned"] = bool(v.planned)
        elif a["id"] in created_planned:
            a["planned"] = created_planned[a["id"]]
        else:
            ca = _day(a["created_at"])
            a["planned"] = bool(ca and a["date"] and ca < a["date"])


def last_visits(db: Session, customer_ids: Iterable[int]) -> dict[int, date]:
    ids = list({int(i) for i in customer_ids})
    if not ids:
        return {}
    rows = db.query(KAMActivity.customer_id, func.max(KAMActivity.activity_date)).filter(
        KAMActivity.customer_id.in_(ids), KAMActivity.activity_type == "Site Visit", KAMActivity.status.in_(DONE),
        KAMActivity.activity_date <= today_ist()).group_by(KAMActivity.customer_id).all()
    return {int(c): _day(d) for c, d in rows if d}


def names(db: Session, ids: Iterable[Optional[int]]) -> dict[int, str]:
    s = {int(i) for i in ids if i}
    return {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(s)).all()} if s else {}


def customer_names(db: Session, ids: Iterable[Optional[int]]) -> dict[int, tuple[str, str, str]]:
    s = {int(i) for i in ids if i}
    if not s:
        return {}
    return {c.id: (c.customer_name, (c.billing_city or "").strip(), (c.billing_state or "").strip())
            for c in db.query(Customer.id, Customer.customer_name, Customer.billing_city, Customer.billing_state).filter(Customer.id.in_(s)).all()}


# ─── targets / per-KAM stats ──────────────────────────────────────────────────

def targets(db: Session, uids: list[int], fy: dict[str, Any]) -> dict[int, dict[str, Any]]:
    """Annual target per KAM: Targets tab value → configured kam_targets quotas for the FY → user master target."""
    out: dict[int, dict[str, Any]] = {u: {"target": 0.0, "source": "none", "updated_by": None, "updated_at": None} for u in uids}
    if not uids:
        return out
    for t in db.query(FieldSalesTarget).filter(FieldSalesTarget.user_id.in_(uids), FieldSalesTarget.fy_start == fy["start"]).all():
        out[int(t.user_id)] = {"target": f(t.annual_target), "source": "field_sales", "updated_by": t.updated_by or t.created_by,
                               "updated_at": (t.updated_at or t.created_at).isoformat() if (t.updated_at or t.created_at) else None}
    rest = {u for u in uids if out[u]["source"] == "none"}
    if rest:
        try:
            from app.services import forecast_service as FS
            p = FS.Period(key="FY", label=fy["label"], full=fy["label"], kind="fy", start=fy["start"], end=fy["end"])
            for u, q in FS._quotas(db, p, rest).items():
                if f(q) > 0:
                    out[int(u)].update(target=f(q), source="kam_targets")
        except Exception as exc:
            db.rollback()
            logger.warning("field sales: configured quotas unavailable: %s", exc)
    rest = [u for u in uids if out[u]["source"] == "none"]
    if rest:
        for u in db.query(User.id, User.target).filter(User.id.in_(rest)).all():
            if f(u.target) > 0:
                out[int(u.id)].update(target=f(u.target), source="user_master")
    return out


def kam_stats(db: Session, cu: User, kams: list[dict[str, Any]], fy: dict[str, Any], *, acts14: Optional[list] = None,
              deal_rows: Optional[list] = None, cust: Optional[list] = None) -> list[dict[str, Any]]:
    ids = [k["id"] for k in kams]
    t = today_ist()
    acts14 = acts14 if acts14 is not None else activities(db, ids, t - timedelta(days=WINDOW - 1), t)
    deal_rows = deal_rows if deal_rows is not None else deals(db, cu, ids)
    cust = cust if cust is not None else customers(db, cu, ids)
    tg = targets(db, ids, fy)
    rows = []
    for k in kams:
        uid = k["id"]
        mine = [d for d in deal_rows if d["owner_id"] == uid]
        won = [d for d in mine if d["kind"] == "won"]
        lost = [d for d in mine if d["kind"] == "lost"]
        a = [x for x in acts14 if x["uid"] == uid]
        achieved = sum(d["value"] for d in won if d["won_on"] and fy["start"] <= d["won_on"] <= fy["end"])
        target = tg[uid]["target"]
        rows.append({"id": uid, "name": k["name"], "target": target, "target_source": tg[uid]["source"],
                     "target_updated_by": tg[uid]["updated_by"], "target_updated_at": tg[uid]["updated_at"],
                     "won": achieved, "attain": round(achieved / target * 100, 1) if target else None,
                     "pipe": sum(d["value"] for d in mine if d["kind"] == "open"),
                     "acts": len(a), "visits": sum(1 for x in a if x["type"] == "Site Visit"),
                     "wr": pct(len(won), len(won) + len(lost)) if (won or lost) else None,
                     "accts": sum(1 for c in cust if c["kam_id"] == uid)})
    return rows


def daily(acts: list[dict[str, Any]], days: list[date]) -> list[int]:
    cnt = defaultdict(int)
    for a in acts:
        cnt[a["date"]] += 1
    return [cnt[d] for d in days]


def city_points(acts: list[dict[str, Any]], cnames: dict[int, tuple[str, str, str]]) -> list[dict[str, Any]]:
    """Group check-ins by city. GPS fixes are averaged per city; without GPS the customer's city reference is used."""
    grp: dict[str, dict[str, Any]] = {}
    for a in acts:
        cn = cnames.get(a["customer_id"] or 0)
        city, state = (cn[1], cn[2]) if cn else ("", "")
        label = city or state or (a["location"] if a.get("point") else "")
        if not label:
            continue
        g = grp.setdefault(label.lower(), {"l": label, "n": 0, "gps": 0, "pts": [], "ref": coord(city, state)})
        g["n"] += 1
        if a.get("point"):
            g["gps"] += 1
            g["pts"].append(a["point"])
    out = []
    for g in grp.values():
        if g["pts"]:
            la, lo = sum(p[0] for p in g["pts"]) / len(g["pts"]), sum(p[1] for p in g["pts"]) / len(g["pts"])
            src = "gps"
        elif g["ref"]:
            la, lo = g["ref"]
            src = "city"
        else:
            continue
        out.append({"l": g["l"], "la": round(la, 4), "lo": round(lo, 4), "n": g["n"], "gps": g["gps"], "src": src})
    return sorted(out, key=lambda x: -x["n"])


def follow_ups_pending(db: Session, uids: list[int]) -> int:
    if not uids:
        return 0
    n = 0
    try:
        from app.models.calendar_tasks import CrmTask
        n += db.query(func.count(CrmTask.id)).filter(CrmTask.assignee_id.in_(uids), CrmTask.status != "Done").scalar() or 0
    except Exception as exc:
        db.rollback()
        logger.warning("field sales: tasks unavailable: %s", exc)
    n += db.query(func.count(KAMActivity.id)).filter(KAMActivity.user_id.in_(uids), KAMActivity.activity_type == "Follow Up",
                                                     KAMActivity.status.in_(("Planned", "Postponed"))).scalar() or 0
    return int(n)


# ─── payloads per tab ─────────────────────────────────────────────────────────

def meta(db: Session, cu: User) -> dict[str, Any]:
    cfg = settings(db)
    fy = fiscal_year(db, cfg)
    return {"me": {"id": cu.id, "name": cu.full_name}, "kams": kam_users(db, cu), "fy": {"label": fy["label"], "start": iso(fy["start"]),
            "end": iso(fy["end"]), "elapsed_pct": fy["elapsed_pct"]},
            "policy": {"A": cfg["A"], "B": cfg["B"], "C": cfg["C"]}, "types": TYPES, "outcomes": list(OUTCOMES),
            "can": {"create": user_has_permission(db, cu, "kam.create"), "update": user_has_permission(db, cu, "kam.update"),
                    "export": user_has_permission(db, cu, "kam.export")}}


def team(db: Session, cu: User) -> dict[str, Any]:
    kams = kam_users(db, cu)
    ids = [k["id"] for k in kams]
    fy, days = fiscal_year(db), window()
    acts = activities(db, ids, days[0], days[-1])
    cust = customers(db, cu, ids)
    st = kam_stats(db, cu, kams, fy, acts14=acts, cust=cust)
    cust_ids = {c["id"] for c in cust}
    covered = {a["customer_id"] for a in acts if a["customer_id"] in cust_ids}
    visits = [a for a in acts if a["type"] == "Site Visit"]
    visit_details(db, visits)
    cn = customer_names(db, [a["customer_id"] for a in visits])
    heat = [[0] * len(days) for _ in kams]
    idx = {d: j for j, d in enumerate(days)}
    pos = {k["id"]: i for i, k in enumerate(kams)}
    for a in acts:
        if a["uid"] in pos and a["date"] in idx:
            heat[pos[a["uid"]]][idx[a["date"]]] += 1
    T, W = sum(x["target"] for x in st), sum(x["won"] for x in st)
    return {"fy": fy["label"], "kpis": {"target": T, "won": W, "attain": round(W / T * 100) if T else None,
            "pipe": sum(x["pipe"] for x in st), "acts": len(acts), "spark": daily(acts, days),
            "visits": len(visits), "covered": len(covered), "customers": len(cust)},
            "map": city_points(visits, cn), "scoreboard": st, "days": [d.isoformat() for d in days], "heat": heat}


def kam360(db: Session, cu: User, uid: int) -> dict[str, Any]:
    require_kam(db, cu, uid)
    u = db.query(User).filter(User.id == uid).first()
    if not u:
        raise HTTPException(404, "Employee not found")
    k = {"id": u.id, "name": u.full_name}
    fy, days, t = fiscal_year(db), window(), today_ist()
    acts = activities(db, [uid], days[0], days[-1])
    deal_rows = deals(db, cu, [uid])
    cust = customers(db, cu, [uid])
    s = kam_stats(db, cu, [k], fy, acts14=acts, deal_rows=deal_rows, cust=cust)[0]
    from app.routers.kam_router import _kam_tender_records_query, _kam_workorder_records_query
    leads_n = db.query(func.count(Lead.id)).filter(Lead.is_deleted == False, Lead.assigned_to == uid,
                                                   func.coalesce(Lead.lead_type, "lead") != "direct_opportunity").scalar() or 0
    bids_n = _kam_tender_records_query(db, [uid], None, None).filter(Tender.assigned_to == uid).count()
    quotes_n = db.query(func.count(Quotation.id)).filter(Quotation.created_by == uid).scalar() or 0
    orders_n = _kam_workorder_records_query(db, [uid], None, None).with_entities(func.count(func.distinct(WorkOrder.id))).scalar() or 0
    journey = [{"l": "Leads", "v": int(leads_n)}, {"l": "Deals", "v": len(deal_rows)}, {"l": "Bids + quotes", "v": int(bids_n) + int(quotes_n)},
               {"l": "Won", "v": sum(1 for d in deal_rows if d["kind"] == "won")}, {"l": "Orders", "v": int(orders_n)}]
    lv = last_visits(db, [c["id"] for c in cust])
    owned = sorted(cust, key=lambda c: -c["revenue"])[:7]
    open_deals = sorted([d for d in deal_rows if d["kind"] == "open"], key=lambda d: -d["value"])[:7]
    log = activities(db, [uid], None, t, statuses=DONE)[:10]
    cn = customer_names(db, [a["customer_id"] for a in log])
    return {"kam": k, "stats": s, "spark": daily(acts, days), "journey": journey,
            "by_type": [{"l": ty, "v": sum(1 for a in acts if a["type"] == ty)} for ty in TYPES],
            "days": [d.isoformat() for d in days], "daily": daily(acts, days),
            "customers": [{**c, "last_visit": iso(lv.get(c["id"]))} for c in owned],
            "deals": [{"id": d["id"], "name": d["name"], "value": d["value"], "stage": d["stage"], "jid": d["jid"], "journey": d["journey"]} for d in open_deals],
            "log": [{"id": a["id"], "date": iso(a["date"]), "time": a["time"], "type": a["type"], "customer": cn.get(a["customer_id"] or 0, ("—",))[0],
                     "customer_id": a["customer_id"], "notes": a["subject"], "outcome": a["outcome"] or (a["outcome_text"][:40] if a["outcome_text"] else None)} for a in log]}


def visits(db: Session, cu: User) -> dict[str, Any]:
    kams = kam_users(db, cu)
    ids = [k["id"] for k in kams]
    days = window()
    rows = activities(db, ids, days[0], days[-1], statuses=DONE, types=["Site Visit"])
    planned_today = activities(db, ids, today_ist(), today_ist(), statuses=("Planned",), types=["Site Visit"])
    visit_details(db, rows)
    cn = customer_names(db, [a["customer_id"] for a in rows + planned_today])
    kn = {k["id"]: k["name"] for k in kams}
    durs = [a["duration"] for a in rows if a["duration"] is not None and a["status"] != "In Progress"]
    dists = [a["distance"] for a in rows if a["distance"] is not None]
    verified = sum(1 for a in rows if a["gps"] == "verified")

    def row(a: dict, planned_slot: bool = False) -> dict[str, Any]:
        c = cn.get(a["customer_id"] or 0)
        loc = (c[1] or c[2]) if c else ""
        if not loc and a.get("point"):
            loc = f"{a['point'][0]:.3f}°N {a['point'][1]:.3f}°E"
        return {"id": a["id"], "date": iso(a["date"]), "check_in": None if planned_slot else a.get("check_in"), "kam": kn.get(a["uid"], ""), "kam_id": a["uid"],
                "customer": c[0] if c else "—", "customer_id": a["customer_id"], "location": loc or a["location"] or "",
                "duration": None if planned_slot else a.get("duration"), "gps": None if planned_slot else a.get("gps"),
                "notes": a["subject"] if not a["description"] else f"{a['subject']} – {a['description'][:160]}" if a["description"] != a["subject"] else a["subject"],
                "outcome": a["outcome"], "status": a["status"], "mine": a["uid"] == cu.id}
    return {"kpis": {"visits": len(rows), "verified": verified, "verified_pct": pct(verified, len(rows)) if rows else None,
                     "avg_min": round(sum(durs) / len(durs)) if durs else None, "timed": len(durs),
                     "distance": round(sum(dists), 1) if dists else None,
                     "unplanned": sum(1 for a in rows if a["planned"] is False)},
            "map": city_points(rows, cn), "per_kam": [{"l": k["name"], "v": sum(1 for a in rows if a["uid"] == k["id"])} for k in kams],
            "log": [row(a, True) for a in planned_today] + [row(a) for a in rows]}


def coverage(db: Session, cu: User) -> dict[str, Any]:
    cfg = settings(db)
    kams = kam_users(db, cu)
    ids = [k["id"] for k in kams]
    kn = {k["id"]: k["name"] for k in kams}
    cust = customers(db, cu, ids)
    lv = last_visits(db, [c["id"] for c in cust])
    t = today_ist()
    rows = []
    for c in cust:
        last = lv.get(c["id"])
        need = cfg.get(c["tier"], 45)
        days_ = (t - last).days if last else None
        rows.append({**c, "kam": kn.get(c["kam_id"], ""), "days": days_, "need": need, "ok": days_ is not None and days_ <= need})
    ok = sum(1 for r in rows if r["ok"])
    by_tier = []
    for tier in ("A", "B", "C"):
        tr = [r for r in rows if r["tier"] == tier]
        by_tier.append({"l": f"Tier {tier}", "v": pct(sum(1 for r in tr if r["ok"]), len(tr))})
    by_kam = []
    for k in kams:
        kr = [r for r in rows if r["kam_id"] == k["id"]]
        by_kam.append({"l": k["name"], "v": pct(sum(1 for r in kr if r["ok"]), len(kr))})
    overdue = sorted([r for r in rows if not r["ok"]], key=lambda r: -r["revenue"])[:10]
    return {"policy": {"A": cfg["A"], "B": cfg["B"], "C": cfg["C"]},
            "kpis": {"customers": len(rows), "ok": ok, "overdue": len(rows) - ok, "never": sum(1 for r in rows if r["days"] is None),
                     "coverage": pct(ok, len(rows)) if rows else None},
            "by_tier": by_tier, "by_kam": by_kam,
            "overdue": [{"id": r["id"], "name": r["name"], "tier": r["tier"], "kam": r["kam"], "days": r["days"], "need": r["need"],
                         "revenue": r["revenue"]} for r in overdue]}


def analytics(db: Session, cu: User) -> dict[str, Any]:
    kams = kam_users(db, cu)
    ids = [k["id"] for k in kams]
    days = window()
    acts = activities(db, ids, days[0], days[-1])
    n = len(acts)
    calls = sum(1 for a in acts if a["type"] == "Call")
    vis = sum(1 for a in acts if a["type"] == "Site Visit")
    prod = []
    for k in kams:
        mine = [a for a in acts if a["uid"] == k["id"]]
        prod.append({"id": k["id"], "name": k["name"], **{ty: sum(1 for a in mine if a["type"] == ty) for ty in TYPES},
                     "positive": pct(sum(1 for a in mine if a["outcome"] == "Positive"), len(mine))})
    return {"kpis": {"acts": n, "positive": pct(sum(1 for a in acts if a["outcome"] == "Positive"), n) if n else None,
                     "per_kam_day": round(n / len(kams) / WINDOW, 1) if kams else None,
                     "followups": follow_ups_pending(db, ids), "ratio": round(vis / calls, 1) if calls else None, "visits": vis, "calls": calls},
            "by_type": [{"l": ty, "v": sum(1 for a in acts if a["type"] == ty)} for ty in TYPES],
            "outcome": [{"l": o, "v": sum(1 for a in acts if a["outcome"] == o)} for o in OUTCOMES],
            "unclassified": sum(1 for a in acts if not a["outcome"]),
            "days": [d.isoformat() for d in days], "daily": daily(acts, days), "productivity": prod}


def target_rows(db: Session, cu: User) -> dict[str, Any]:
    kams = kam_users(db, cu)
    fy = fiscal_year(db)
    st = kam_stats(db, cu, kams, fy, acts14=[], cust=[])
    who = names(db, [x["target_updated_by"] for x in st])
    editable = can_edit_targets(db, cu)
    rows = []
    for x in st:
        a = x["won"] / x["target"] * 100 if x["target"] else None
        rows.append({"id": x["id"], "name": x["name"], "target": x["target"], "source": x["target_source"], "won": x["won"],
                     "attain": round(a, 1) if a is not None else None, "gap": max(0.0, x["target"] - x["won"]),
                     "runrate": round(a - fy["elapsed_pct"]) if a is not None else None,
                     "can_edit": editable and _may_edit(db, cu, x["id"]),
                     "updated_by": who.get(x["target_updated_by"] or 0), "updated_at": x["target_updated_at"]})
    return {"fy": fy["label"], "elapsed_pct": fy["elapsed_pct"], "rows": rows}


def territories(db: Session, cu: User) -> dict[str, Any]:
    kams = kam_users(db, cu)
    cust = customers(db, cu, [k["id"] for k in kams])
    states = sorted({c["state"] or "Unspecified" for c in cust})
    heat = [[sum(1 for c in cust if (c["state"] or "Unspecified") == s and c["kam_id"] == k["id"]) for k in kams] for s in states]
    rev = sorted([{"l": s, "v": round(sum(c["revenue"] for c in cust if (c["state"] or "Unspecified") == s), 2)} for s in states], key=lambda x: -x["v"])
    per = sorted([{"l": k["name"], "v": sum(1 for c in cust if c["kam_id"] == k["id"])} for k in kams], key=lambda x: -x["v"])
    return {"states": states, "kams": [k["name"] for k in kams], "heat": heat, "revenue": rev, "per_kam": per}


# ─── target updates ───────────────────────────────────────────────────────────

def can_edit_targets(db: Session, cu: User) -> bool:
    return user_has_permission(db, cu, "kam.update")


def _may_edit(db: Session, cu: User, uid: int) -> bool:
    """Targets are set by someone above the KAM: own target only when the role's KAM visibility is "all"."""
    from app.utils.data_scope import get_module_data_scope
    if int(uid) not in set(scope_uids(db, cu)):
        return False
    return int(uid) != int(cu.id) or get_module_data_scope(db, cu, "kam") == "all"


def set_target(db: Session, cu: User, uid: int, amount_lakh: Any, request: Optional[Request]) -> dict[str, Any]:
    if not can_edit_targets(db, cu):
        raise HTTPException(403, "You don't have permission to edit targets")
    if not _may_edit(db, cu, uid):
        raise HTTPException(403, "You can't set a target for this employee")
    try:
        lakh = Decimal(str(amount_lakh))
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(422, "Enter the annual target as a number of lakhs")
    if not lakh.is_finite() or lakh < 0 or lakh > Decimal("10000000"):
        raise HTTPException(422, "Annual target must be between 0 and 1,00,00,000 lakh")
    rupees = (lakh * Decimal(100000)).quantize(Decimal("0.01"))
    u = db.query(User).filter(User.id == uid).first()
    if not u:
        raise HTTPException(404, "Employee not found")
    fy = fiscal_year(db)
    row = db.query(FieldSalesTarget).filter(FieldSalesTarget.user_id == uid, FieldSalesTarget.fy_start == fy["start"]).with_for_update().first()
    old = Decimal(str(row.annual_target)) if row else Decimal(str(targets(db, [uid], fy)[uid]["target"]))
    now = now_ist()
    if row:
        row.annual_target, row.updated_by, row.updated_at = rupees, cu.id, now
    else:
        db.add(FieldSalesTarget(user_id=uid, fy_start=fy["start"], annual_target=rupees, created_by=cu.id, updated_by=cu.id, created_at=now, updated_at=now))
    ip = get_request_ip(request) if request else None
    db.add(FieldSalesTargetHistory(user_id=uid, fy_start=fy["start"], old_value=old, new_value=rupees, changed_by=cu.id, changed_at=now, ip_address=ip))
    u.target = rupees if rupees > 0 else None          # keep the Users & Teams master target in step (as the KAM module does)
    db.commit()
    try:
        from app.core.logging import log_audit_db
        log_audit_db(db, cu.id, "kam", "update", uid, ip or "", f"Field Sales 360: {fy['label']} target for {u.full_name} set to ₹{lakh} L",
                     old_data={"annual_target": float(old)}, new_data={"annual_target": float(rupees)}, record_name=u.full_name)
    except Exception as exc:
        logger.warning("field sales target audit failed: %s", exc)
    return next(r for r in target_rows(db, cu)["rows"] if r["id"] == uid)


def target_history(db: Session, cu: User, uid: int) -> list[dict[str, Any]]:
    require_kam(db, cu, uid)
    rows = db.query(FieldSalesTargetHistory).filter(FieldSalesTargetHistory.user_id == uid).order_by(FieldSalesTargetHistory.changed_at.desc()).limit(50).all()
    who = names(db, [r.changed_by for r in rows])
    return [{"fy_start": iso(r.fy_start), "old": f(r.old_value), "new": f(r.new_value), "by": who.get(r.changed_by or 0, ""),
             "at": r.changed_at.isoformat() if r.changed_at else None} for r in rows]


# ─── log activity / check-in / check-out ──────────────────────────────────────

def _gps_state(gps: Optional[dict], permission: Optional[str]) -> tuple[Optional[str], Optional[float], Optional[float], Optional[float]]:
    if gps and gps.get("lat") is not None and gps.get("lng") is not None:
        lat, lng = float(gps["lat"]), float(gps["lng"])
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise HTTPException(422, "Invalid GPS coordinates")
        acc = float(gps["accuracy"]) if gps.get("accuracy") is not None else None
        return ("verified" if acc is not None and acc <= GPS_MAX_ACCURACY_M else "manual"), lat, lng, acc
    if permission == "denied":
        return "denied", None, None, None
    return None, None, None, None


def form_meta(db: Session, cu: User, customer_id: Optional[int]) -> dict[str, Any]:
    from app.routers.customer_router import _apply_customer_data_scope
    from app.services import customer360_service as S
    cust = []
    if user_has_permission(db, cu, "customers.view"):
        cust = [{"id": c.id, "name": c.customer_name} for c in _apply_customer_data_scope(db, db.query(Customer.id, Customer.customer_name), cu)
                .filter(Customer.is_deleted == False).order_by(Customer.customer_name).limit(5000).all()]
    out: dict[str, Any] = {"customers": cust, "kams": kam_users(db, cu), "me": cu.id, "contacts": [], "links": [], "snapshot": None,
                           "competitors": [], "users": [{"id": u.id, "name": u.full_name} for u in db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).limit(500).all()]}
    try:
        from app.models.all_models import Competitor
        out["competitors"] = [r[0] for r in db.query(Competitor.name).order_by(Competitor.name).limit(300).all()]
    except Exception:
        db.rollback()
    if customer_id and any(c["id"] == customer_id for c in cust):
        c = db.query(Customer).filter(Customer.id == customer_id).first()
        out["contacts"] = [{"id": x.id, "name": x.contact_name} for x in db.query(CustomerContact.id, CustomerContact.contact_name)
                           .filter(CustomerContact.customer_id == customer_id, CustomerContact.is_active == True).order_by(CustomerContact.contact_name).all()]
        links = []
        for l in db.query(Lead.id, Lead.lead_title, Lead.lead_type, Lead.status).filter(Lead.customer_id == customer_id, Lead.is_deleted == False).order_by(Lead.id.desc()).limit(30).all():
            is_deal = (l.lead_type == "direct_opportunity") or (l.status in ("Opportunity Created", "Converted"))
            links.append({"k": "lead", "id": l.id, "l": f"{'Deal' if is_deal else 'Lead'} · {(l.lead_title or '')[:30]}"})
        for t in db.query(Tender.id, Tender.tender_num, Tender.tender_status).filter(Tender.customer_id == customer_id, Tender.is_deleted == False).order_by(Tender.id.desc()).limit(20).all():
            links.append({"k": "tender", "id": t.id, "l": f"Bid · {t.tender_num or t.id} · {t.tender_status or ''}"})
        out["links"] = links
        m = S.metrics_for(S.account_metrics(db, {customer_id}), customer_id)
        recent = db.query(KAMActivity.activity_type, KAMActivity.activity_date, KAMActivity.subject).filter(
            KAMActivity.customer_id == customer_id, KAMActivity.status.in_(DONE)).order_by(KAMActivity.activity_date.desc()).limit(3).all()
        k = S.Family(db).kam(customer_id, S.profiles(db, [customer_id]))[0]
        out["snapshot"] = {"name": c.customer_name, "health": int(m["health"]), "tier": S.TIER_OF.get(c.account_potential or "Medium", "B"),
                           "city": c.billing_city or "", "kam": names(db, [k]).get(k or 0, ""), "kam_id": k,
                           "open_pipe": round(m["open_pipe"], 2), "live_bids": m["live_bids"], "outstanding": round(m["outstanding"], 2),
                           "last_touch": (today_ist() - m["last_touch"]).days if m["last_touch"] else None,
                           "recent": [{"type": TYPE_GROUP.get(r.activity_type or "", r.activity_type), "date": iso(r.activity_date), "note": (r.subject or "")[:70]} for r in recent]}
    return out


def log_activity(db: Session, cu: User, body: Any, request: Request) -> dict[str, Any]:
    from app.routers import kam_router as K
    if body.type not in TYPES:
        raise HTTPException(422, "Choose an activity type")
    if body.outcome and body.outcome not in OUTCOMES:
        raise HTTPException(422, "Choose an outcome")
    if body.action not in ("log", "check_in", "plan"):
        raise HTTPException(422, "Unknown action")
    kam_id = int(body.kam_id or cu.id)
    if kam_id != cu.id:
        require_kam(db, cu, kam_id)
    if body.action == "check_in":
        if body.type != "Site Visit":
            raise HTTPException(422, "Only site visits are checked in")
        if kam_id != cu.id:
            raise HTTPException(403, "Only the employee on site can check in")
    if body.gps and kam_id != cu.id:
        raise HTTPException(403, "Location can only be captured for your own visit")
    c = db.query(Customer.id, Customer.customer_name).filter(Customer.id == body.customer_id, Customer.is_deleted == False).first()
    if not c:
        raise HTTPException(422, "Choose a customer")
    allowed = {x["id"] for x in form_meta_customers(db, cu)}
    if c.id not in allowed:
        raise HTTPException(403, "You can't log activities for this customer")
    notes = (body.notes or "").strip()
    subject = (notes.split("\n")[0][:120] if notes else f"{body.type} with {c.customer_name}")
    extra = []
    if body.topics:
        extra.append("Topics: " + ", ".join(body.topics))
    if body.competitor:
        extra.append("Competitor: " + body.competitor)
    if body.attendees:
        extra.append("Also present: " + ", ".join(body.attendees))
    description = "\n".join([notes] + extra).strip() or None
    status = {"log": "Completed", "check_in": "In Progress", "plan": "Planned"}[body.action]
    if status == "Completed" and not body.outcome:
        raise HTTPException(422, "Choose the outcome")
    act_date = today_ist() if body.action == "check_in" else body.date
    if body.action == "log" and act_date > today_ist():
        raise HTTPException(422, "A completed activity can't be dated in the future – use Plan visit")
    gps_state, lat, lng, acc = _gps_state(body.gps, body.gps_permission)
    payload = K.ActivityCreate(
        activity_type=TYPE_TO_DB[body.type], customer_id=c.id,
        lead_id=body.link_id if body.link_kind == "lead" else None, tender_id=body.link_id if body.link_kind == "tender" else None,
        subject=subject, description=description, activity_date=act_date,
        start_time=(now_ist().strftime("%H:%M") if body.action == "check_in" else body.time), duration_minutes=body.duration,
        location=body.where, mode="In-Person" if body.type in ("Site Visit", "Meeting", "Demo") else "Phone",
        status=status, outcome=body.outcome if status == "Completed" else None,
        contacts_met=[body.contact_id] if body.contact_id else None, on_behalf_of=kam_id if kam_id != cu.id else None)
    created = K.create_activity(payload, request, db, cu)
    aid = int(created["id"])
    try:
        now = now_ist()
        v = FieldVisit(activity_id=aid, planned=(body.action == "plan") or bool(body.planned), outcome_rating=body.outcome if status == "Completed" else None,
                       sentiment=body.sentiment, created_by=cu.id, updated_by=cu.id,
                       distance_km=Decimal(str(body.distance_km)) if body.distance_km not in (None, "") else None)
        if gps_state or body.action == "check_in":
            v.check_in_at = now
            v.gps_status = gps_state or "manual"
            v.check_in_lat, v.check_in_lng, v.check_in_accuracy = lat, lng, acc
        db.add(v)
        if gps_state:
            act = db.query(KAMActivity).filter(KAMActivity.id == aid).first()
            from app.services.kam_activity_audit_service import log_kam_activity
            log_kam_activity(db, activity_id=aid, event_type="VISIT_CHECK_IN", actor=cu, new_status=act.status if act else None, source="web",
                             request=request, permission_status="granted" if lat is not None else gps_state, capture_source="browser",
                             metadata={"gps": gps_state, "accuracy_m": acc})
        if body.next_title and body.next_due:
            from app.models.calendar_tasks import CrmTask
            from app.services.calendar_service import ensure_calendar_schema
            ensure_calendar_schema(db)
            task = CrmTask(title=body.next_title.strip()[:300], related_module="customers", related_id=c.id, related_label=c.customer_name[:300],
                           assignee_id=kam_id, priority="High" if body.outcome == "Negative" else "Medium", due_date=body.next_due,
                           status="To do", source="field_sales", created_by=cu.id)
            db.add(task)
            db.flush()
            v.followup_task_id = task.id
        if body.expense and float(body.expense) > 0:
            db.add(KAMTravelExpense(activity_id=aid, user_id=kam_id, customer_id=c.id, expense_type=body.expense_category or "Travel",
                                    amount=Decimal(str(body.expense)), travel_date=act_date, created_by=cu.id,
                                    distance_km=float(body.distance_km) if body.distance_km not in (None, "") else None,
                                    notes=f"Logged with activity #{aid} from Field Sales 360"))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("field sales: activity %s saved, visit details failed", aid)
        raise HTTPException(500, f"Activity was saved but its visit details could not be stored: {exc}")
    return {"id": aid, "status": status, "followup_task": bool(body.next_title and body.next_due), "gps": gps_state}


def form_meta_customers(db: Session, cu: User) -> list[dict[str, Any]]:
    from app.routers.customer_router import _apply_customer_data_scope
    if not user_has_permission(db, cu, "customers.view"):
        return []
    return [{"id": r[0]} for r in _apply_customer_data_scope(db, db.query(Customer.id), cu).filter(Customer.is_deleted == False).all()]


def _own_visit(db: Session, cu: User, activity_id: int) -> tuple[KAMActivity, FieldVisit]:
    act = db.query(KAMActivity).filter(KAMActivity.id == activity_id).with_for_update().first()
    if not act or act.activity_type != "Site Visit":
        raise HTTPException(404, "Visit not found")
    if int(act.user_id) != int(cu.id):
        raise HTTPException(403, "Only the employee on the visit can check in or out")
    v = db.query(FieldVisit).filter(FieldVisit.activity_id == activity_id).first()
    if not v:
        v = FieldVisit(activity_id=activity_id, created_by=cu.id)
        db.add(v)
    return act, v


def check_in(db: Session, cu: User, activity_id: int, body: Any, request: Request) -> dict[str, Any]:
    from app.services.kam_activity_audit_service import get_or_create_open_cycle, log_kam_activity
    act, v = _own_visit(db, cu, activity_id)
    if act.status not in ("Planned", "Postponed", "Reopened"):
        raise HTTPException(400, f"A {act.status.lower()} visit can't be checked in")
    gps_state, lat, lng, acc = _gps_state(body.gps, body.gps_permission)
    now = now_ist()
    cycle = get_or_create_open_cycle(db, act)
    cycle.started_at, cycle.started_by, cycle.status = now, cu.id, "In Progress"
    prev = act.status
    if v.planned is None:
        v.planned = prev in ("Planned", "Postponed")
    act.status, act.activity_date, act.start_time, act.updated_at = "In Progress", now.date(), now.time().replace(microsecond=0), now
    v.check_in_at, v.gps_status, v.check_in_lat, v.check_in_lng, v.check_in_accuracy, v.updated_by = now, gps_state or "manual", lat, lng, acc, cu.id
    log_kam_activity(db, activity_id=act.id, event_type="VISIT_CHECK_IN", cycle_no=act.current_cycle_no or 1, actor=cu, previous_status=prev,
                     new_status="In Progress", source="web", request=request, capture_source="browser",
                     permission_status="granted" if lat is not None else (gps_state or "not_requested"), metadata={"gps": gps_state, "accuracy_m": acc})
    db.commit()
    return {"id": act.id, "status": act.status, "gps": v.gps_status, "check_in": hhmm(now)}


def check_out(db: Session, cu: User, activity_id: int, body: Any, request: Request) -> dict[str, Any]:
    from app.services.kam_activity_audit_service import complete_activity_cycle
    act, v = _own_visit(db, cu, activity_id)
    if act.status != "In Progress":
        raise HTTPException(400, "Only a visit in progress can be checked out")
    if body.outcome not in OUTCOMES:
        raise HTTPException(422, "Choose the outcome")
    _, lat, lng, acc = _gps_state(body.gps, body.gps_permission)
    now = now_ist()
    notes = (body.notes or "").strip() or None
    if notes:
        act.description = ((act.description or "") + ("\n" if act.description else "") + notes)[:65000]
    act.outcome = body.outcome
    complete_activity_cycle(db, act, cu, notes=notes, outcome=body.outcome, source="web", request=request, capture_source="browser",
                            permission_status="granted" if lat is not None else "not_requested")
    v.check_out_at, v.check_out_lat, v.check_out_lng, v.check_out_accuracy = now, lat, lng, acc
    v.outcome_rating, v.updated_by = body.outcome, cu.id
    if not v.check_in_at:
        v.check_in_at = now
    if body.distance_km not in (None, ""):
        d = float(body.distance_km)
        if d < 0 or d > 5000:
            raise HTTPException(422, "Distance must be between 0 and 5000 km")
        v.distance_km = Decimal(str(round(d, 2)))
    db.commit()
    dur = int((v.check_out_at - v.check_in_at).total_seconds() // 60)
    return {"id": act.id, "status": act.status, "duration": dur}
