"""Reports (prototype v17 · Intelligence → Reports) – catalogue, report runs, favourites, custom reports (Builder),
exports (PDF / Excel / CSV), e-mail via the Inbox composer and scheduled deliveries.

* Ready-made reports – reports_v17_data.REPORTS (21 definitions). A report is listed and runnable only when the user holds
  reports.view and every module permission the report reads; rows then come from each module's own scoped service.
* Custom reports     – the report engine's saved_reports (Builder → Save), run through the engine with the user's report-type
  access and data scope. Group by is kept in chart_config_json.group_by.
* Periods            – FY (Settings fiscal_year_start, IST), QTR = last 90 days, MTD = last 30 days (prototype option values).
* Exports            – generated on the server: CSV (UTF-8 with BOM), Excel (openpyxl) and PDF (built-in writer, no extra
  dependency). Every file carries the title, company, period, generation time and the report's period basis.
* E-mail             – the generated file is stored in Document Hub (owner = the user) and pre-attached to the existing Inbox
  composer, which sends it through the configured mailbox and reports the delivery status.
* Schedules          – report_schedules, executed by the platform job "report_schedules" as the schedule owner with the
  owner's permissions at run time; each schedule is claimed atomically so two workers never send it twice. Failures are
  retried after 30 minutes (3 attempts) and recorded in report_runs / platform_job_runs.
"""
from __future__ import annotations

import csv
import io
import logging
import re
import threading
import zlib
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.core.timezone import now_ist, today_ist
from app.dependencies import user_has_permission
from app.models.all_models import User
from app.models.reports360 import FORMATS, FREQUENCIES, PERIODS, REPORTS360_TABLES, ReportFavourite, ReportRun, ReportSchedule
from app.services import reports_v17_data as RD

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()
PERIOD_LABEL = {"FY": "This FY", "QTR": "Last 90 days", "MTD": "Last 30 days"}
EMAIL_RE = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[A-Za-z]{2,}$")
MAX_EXPORT_ROWS = 50000
MAX_GROUP_ROWS = 20000
BUILDER_SOURCES = [   # prototype builder data sources (M keys with columns) → report engine single-module types
    ("customers", "Customers"), ("leads", "Leads"), ("opportunities", "Deals"), ("tenders", "Bids & Tenders"), ("quotations", "Quotes"),
    ("workorders", "Orders & Projects"), ("emdbg", "Guarantees & Deposits"), ("travel", "Travel & Expense"), ("kam_activities", "Activities"),
]


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        for t in REPORTS360_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    for slug, db in _tenant_sessions():
        try:
            ensure_schema(db)
        except Exception as exc:
            logger.warning("reports schema for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()


def _tenant_sessions():
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
            logger.warning("reports: tenant %s unavailable: %s", slug, exc)
            continue
        db.info["tenant_slug"] = slug
        yield slug, db


# ─── helpers ──────────────────────────────────────────────────────────────────

def company_name(db: Session) -> str:
    try:
        from app.routers.customer360_router import company_name as cn
        return cn(db) or "Workspace"
    except Exception:
        return "Workspace"


def period_window(db: Session, key: str) -> tuple[date, date, str, dict]:
    from app.services.field_sales_service import fiscal_year
    fy = fiscal_year(db)
    t = today_ist()
    if key == "QTR":
        return t - timedelta(days=89), t, PERIOD_LABEL["QTR"], fy
    if key == "MTD":
        return t - timedelta(days=29), t, PERIOD_LABEL["MTD"], fy
    return fy["start"], fy["end"], f"This FY ({fy['label']})", fy


def can_report(db: Session, cu: User, d: dict) -> bool:
    return user_has_permission(db, cu, "reports.view") and all(user_has_permission(db, cu, p) for p in d["perm"])


def _engine():
    from app.routers import report_engine_router as E
    return E


def custom_reports(db: Session, cu: User) -> list[dict]:
    """User-built reports (Builder → Save) the user may open: own + organisation-wide, with report-type access."""
    E = _engine()
    from app.models.all_models import ReportType, SavedReport
    try:
        granted = E._granted_permission_keys(db, cu)
        if "*" not in granted and not any(k in granted for k in E.REPORT_ENGINE_PERMISSION_KEYS):
            return []
        out = []
        for r, key in db.query(SavedReport, ReportType.key).join(ReportType, ReportType.id == SavedReport.report_type_id).filter(
                SavedReport.is_active == True, SavedReport.is_system == False).order_by(SavedReport.name).all():
            if E._can_view_report(r, cu) and E._has_report_type_access(key, db, cu, granted):
                src = dict(BUILDER_SOURCES).get(key, key)
                out.append({"key": f"c:{r.id}", "cat": "Custom", "n": r.name, "d": r.description or f"Custom report on {src}", "custom": True,
                            "saved_id": r.id, "type": key, "owner": r.created_by, "visibility": r.visibility,
                            "group_by": (r.chart_config_json or {}).get("group_by") if isinstance(r.chart_config_json, dict) else None})
        return out
    except Exception as exc:
        db.rollback()
        logger.warning("custom reports unavailable: %s", exc)
        return []


def definition(db: Session, cu: User, key: str) -> dict:
    if key.startswith("c:"):
        d = next((c for c in custom_reports(db, cu) if c["key"] == key), None)
    else:
        d = RD.BY_KEY.get(key)
        if d and not can_report(db, cu, d):
            raise HTTPException(403, "You don't have access to this report")
    if not d:
        raise HTTPException(404, "Report not found")
    return d


# ─── catalogue / favourites ───────────────────────────────────────────────────

def catalogue(db: Session, cu: User) -> dict[str, Any]:
    ensure_schema(db)
    if not user_has_permission(db, cu, "reports.view"):
        raise HTTPException(403, "You don't have access to Reports")
    favs = {f.report_key for f in db.query(ReportFavourite.report_key).filter(ReportFavourite.user_id == cu.id).all()}
    sch = {s.report_key: s for s in db.query(ReportSchedule).filter(ReportSchedule.user_id == cu.id, ReportSchedule.is_active == True).all()}
    ready = [d for d in RD.REPORTS if can_report(db, cu, d)]
    items = [{"key": d["key"], "cat": d["cat"], "n": d["n"], "d": d["d"], "custom": False} for d in ready] + \
            [{k: c[k] for k in ("key", "cat", "n", "d", "custom")} for c in custom_reports(db, cu)]
    for it in items:
        it["fav"] = it["key"] in favs
        s = sch.get(it["key"])
        it["schedule"] = s.frequency if s else None
    cats = []
    for it in items:
        if it["cat"] not in cats:
            cats.append(it["cat"])
    me = db.query(User.email).filter(User.id == cu.id).scalar()
    return {"company": company_name(db), "ready_count": len(ready), "items": items, "categories": ["All", "Favourites", "Scheduled", *cats],
            "periods": [{"v": k, "l": v} for k, v in PERIOD_LABEL.items()], "frequencies": list(FREQUENCIES), "formats": list(FORMATS),
            "me": {"id": cu.id, "name": cu.full_name, "email": me or ""},
            "can": {"export": user_has_permission(db, cu, "reports.export"), "schedule": user_has_permission(db, cu, "reports.schedule"),
                    "share": user_has_permission(db, cu, "reports.share"), "build": user_has_permission(db, cu, "report_engine.view"),
                    "docs": user_has_permission(db, cu, "document_management.view")}}


def set_favourite(db: Session, cu: User, key: str, on: bool) -> dict[str, Any]:
    ensure_schema(db)
    definition(db, cu, key)
    row = db.query(ReportFavourite).filter(ReportFavourite.user_id == cu.id, ReportFavourite.report_key == key).first()
    if on and not row:
        db.add(ReportFavourite(user_id=cu.id, report_key=key))
    elif not on and row:
        db.delete(row)
    db.commit()
    return {"key": key, "fav": on}


# ─── run ──────────────────────────────────────────────────────────────────────

def run(db: Session, cu: User, key: str, period: str, *, row_cap: Optional[int] = 5000) -> dict[str, Any]:
    ensure_schema(db)
    if period not in PERIODS:
        raise HTTPException(422, "Unknown reporting period")
    d = definition(db, cu, key)
    start, end, plabel, fy = period_window(db, period)
    if d.get("custom"):
        out = _run_custom(db, cu, d, start, end, row_cap or MAX_EXPORT_ROWS)
    else:
        ctx = RD.Ctx(db=db, cu=cu, start=start, end=end, label=plabel, fy=fy)
        out = d["fn"](ctx)
    rows = out.get("rows") or []
    total = len(rows)
    if row_cap and total > row_cap:
        rows = rows[:row_cap]
    fav = db.query(ReportFavourite.id).filter(ReportFavourite.user_id == cu.id, ReportFavourite.report_key == key).first() is not None
    s = db.query(ReportSchedule).filter(ReportSchedule.user_id == cu.id, ReportSchedule.report_key == key).first()
    return {"key": key, "cat": d["cat"], "n": d["n"], "d": d["d"], "custom": bool(d.get("custom")), "generated": now_ist().isoformat(timespec="minutes"),
            "company": company_name(db), "period": period, "period_label": plabel, "start": start.isoformat(), "end": end.isoformat(),
            "basis": d.get("basis") if not d.get("custom") else "Created date", "note": out.get("note"),
            "k": out.get("k", []), "c": out.get("c", []), "cols": out.get("cols", []), "rows": _jsonable(rows), "total": total, "truncated": total > len(rows),
            "open": out.get("open"), "fav": fav, "schedule": _sched_dict(s)}


def _jsonable(rows: list[dict]) -> list[dict]:
    out = []
    for i, r in enumerate(rows):
        o = {}
        for k, v in r.items():
            if k == "journey":
                o[k] = v
            elif isinstance(v, (datetime, date)):
                o[k] = v.isoformat()
            elif isinstance(v, Decimal):
                o[k] = float(v)
            elif isinstance(v, (str, int, float, bool)) or v is None or isinstance(v, (list, dict)):
                o[k] = v
            else:
                o[k] = str(v)
        o.setdefault("id", i)
        out.append(o)
    return out


def _engine_fields(db: Session, cu: User, type_key: str) -> list[dict]:
    return _engine().get_report_type_fields(type_key, db, cu)


def _value_field(fields: list[dict]) -> Optional[str]:
    """The 'Total value' column of a grouped report: a currency field named like a value (est. value, order value …) first."""
    for f in fields:
        if f["data_type"] == "currency" and f["is_aggregatable"] and "value" in f["field_key"].lower():
            return f["field_key"]
    for f in fields:
        if f["data_type"] in ("currency",) and f["is_aggregatable"]:
            return f["field_key"]
    for f in fields:
        if f["data_type"] in ("currency", "number", "decimal") and f["is_aggregatable"]:
            return f["field_key"]
    return None


def _engine_rows(db: Session, cu: User, type_key: str, fields: list[str], start: Optional[date], end: Optional[date], cap: int) -> tuple[list[dict], int]:
    E = _engine()
    rows, page, total = [], 1, 0
    while len(rows) < cap:
        cfg = {"report_type_key": type_key, "fields": fields, "filters": [], "sort": [], "page": page, "per_page": 500,
               "date_from": start.isoformat() if start else None, "date_to": end.isoformat() if end else None}
        res = E._run_report(type_key, cfg, cu, db)
        total = int(res.get("total") or 0)
        rows.extend(res.get("rows") or [])
        if page >= int(res.get("pages") or 1):
            break
        page += 1
    return rows[:cap], total


def _fmt_of(f: dict) -> str:
    t = f["data_type"]
    return {"currency": "inr", "date": "d", "datetime": "d", "enum": "pill", "number": "num", "decimal": "num"}.get(t, "text")


def _run_custom(db: Session, cu: User, d: dict, start: date, end: date, cap: int) -> dict[str, Any]:
    E = _engine()
    from app.models.all_models import SavedReport
    r = db.query(SavedReport).filter(SavedReport.id == d["saved_id"]).first()
    cfg = E._saved_report_config_for_runtime(r, d["type"])
    meta = {f["field_key"]: f for f in _engine_fields(db, cu, d["type"])}
    fields = [f for f in (cfg.get("fields") or []) if f in meta] or [k for k, f in meta.items() if f["is_default_column"]]
    vf = _value_field(list(meta.values()))
    grp = d.get("group_by") if d.get("group_by") in meta else None
    need = list(dict.fromkeys(fields + ([grp] if grp else []) + ([vf] if vf else [])))
    rows, total = _engine_rows(db, cu, d["type"], need, start, end, cap)
    tv = sum((RD.D(x.get(vf)) for x in rows), Decimal(0)) if vf else None
    k = [RD.K("Records", total)] + ([RD.K(f"Total {meta[vf]['label'].lower()}", float(tv), "inr")] if vf else [])
    c = []
    if grp:
        g = RD.grp(rows, lambda x: x.get(grp), (lambda x: x.get(vf)) if vf else None)
        c.append(RD.CH(f"By {meta[grp]['label'].lower()}", "hbars", sorted([{"l": z["l"], "v": z["n"]} for z in g], key=lambda z: -z["v"])[:12], lw=140, vw=40))
        cols = [RD.C("g", meta[grp]["label"]), RD.C("n", "Count", "int", r=True, sum=True), RD.INR("v", "Total value")]
        rows = sorted([{"id": i, "g": z["l"], "n": z["n"], "v": z["v"]} for i, z in enumerate(g)], key=lambda z: -z["n"])
    else:
        cols = [RD.C(fk, meta[fk]["label"], _fmt_of(meta[fk]), **({"r": True, "money": True, "sum": True} if meta[fk]["data_type"] == "currency" else {}))
                for fk in fields]
    return {"k": k, "c": c, "cols": cols, "rows": rows, "note": f"Custom report on {dict(BUILDER_SOURCES).get(d['type'], d['type'])}"
            + (f" · grouped by {meta[grp]['label']}" if grp else "")}


# ─── builder ──────────────────────────────────────────────────────────────────

def builder_sources(db: Session, cu: User) -> list[dict]:
    if not user_has_permission(db, cu, "report_engine.view"):
        raise HTTPException(403, "You don't have permission to build reports")
    types = {t["key"]: t for t in _engine().list_report_types(db, cu)}
    return [{"key": k, "label": lbl} for k, lbl in BUILDER_SOURCES if k in types]


def builder_fields(db: Session, cu: User, source: str) -> list[dict]:
    if source not in {s["key"] for s in builder_sources(db, cu)}:
        raise HTTPException(403, "You don't have access to this data source")
    fs = sorted(_engine_fields(db, cu, source), key=lambda f: (f.get("display_order") or 0))
    return [{"key": f["field_key"], "label": f["label"], "type": f["data_type"], "groupable": bool(f["is_groupable"]),
             "default": bool(f["is_default_column"]), "fmt": _fmt_of(f)} for f in fs if f["field_key"] != "id"]


def builder_preview(db: Session, cu: User, source: str, fields: list[str], group: Optional[str]) -> dict[str, Any]:
    meta = {f["key"]: f for f in builder_fields(db, cu, source)}
    fields = [f for f in fields if f in meta]
    if group and (group not in meta or not meta[group]["groupable"]):
        raise HTTPException(422, "This field can't be used for grouping")
    if not fields and not group:
        return {"grouped": False, "cols": [], "rows": [], "total": 0}
    if group:
        vf = _value_field([{"field_key": k, "data_type": m["type"], "is_aggregatable": m["type"] in ("currency", "number", "decimal")} for k, m in meta.items()])
        rows, total = _engine_rows(db, cu, source, list(dict.fromkeys([group] + ([vf] if vf else []))), None, None, MAX_GROUP_ROWS)
        g = RD.grp(rows, lambda x: x.get(group), (lambda x: x.get(vf)) if vf else None)
        return {"grouped": True, "group_label": meta[group]["label"], "value_label": meta[vf]["label"] if vf else None,
                "rows": sorted([{"g": z["l"], "n": z["n"], "v": z["v"]} for z in g], key=lambda z: -z["n"]), "total": total,
                "capped": total > MAX_GROUP_ROWS}
    E = _engine()
    res = E._run_report(source, {"report_type_key": source, "fields": fields, "filters": [], "sort": [], "page": 1, "per_page": 50}, cu, db)
    return {"grouped": False, "cols": [{"k": f, "t": meta[f]["label"], "fmt": meta[f]["fmt"]} for f in fields],
            "rows": _jsonable(res.get("rows") or []), "total": int(res.get("total") or 0)}


def builder_save(db: Session, cu: User, b: Any) -> dict[str, Any]:
    if not user_has_permission(db, cu, "report_engine.view"):
        raise HTTPException(403, "You don't have permission to save reports")
    name = (b.name or "").strip()
    if len(name) < 3:
        raise HTTPException(422, "Give the report a name (at least 3 characters)")
    if len(name) > 150:
        raise HTTPException(422, "Report name is too long")
    meta = {f["key"]: f for f in builder_fields(db, cu, b.source)}
    fields = [f for f in b.fields if f in meta]
    if not fields:
        raise HTTPException(422, "Choose at least one column")
    if b.group and (b.group not in meta or not meta[b.group]["groupable"]):
        raise HTTPException(422, "This field can't be used for grouping")
    if b.visibility not in ("private", "org"):
        raise HTTPException(422, "Unknown visibility")
    from app.models.all_models import ReportType, SavedReport
    if db.query(SavedReport.id).filter(SavedReport.created_by == cu.id, SavedReport.name == name, SavedReport.is_active == True).first():
        raise HTTPException(409, "You already have a report with this name")
    E = _engine()
    res = E.create_saved_report(E.SavedReportCreate(name=name, description=(b.description or "").strip()[:500] or None, report_type_key=b.source,
                                                    visibility=b.visibility, config_json={"fields": fields},
                                                    chart_config_json={"group_by": b.group or None, "source": b.source, "builder": "v17"}), db, cu)
    return {"key": f"c:{res['id']}", "id": res["id"], "name": res["name"]}


# ─── schedules ────────────────────────────────────────────────────────────────

def next_run(freq: str, after: Optional[datetime] = None) -> datetime:
    t = after or now_ist()
    at8 = lambda d: datetime(d.year, d.month, d.day, 8, 0)
    if freq == "Daily · 08:00":
        n = at8(t.date())
        return n if n > t else at8(t.date() + timedelta(days=1))
    if freq == "Weekly · Mon 08:00":
        d = t.date() + timedelta(days=(0 - t.weekday()) % 7)
        n = at8(d)
        return n if n > t else at8(d + timedelta(days=7))
    if freq == "Monthly · 1st":
        n = at8(date(t.year, t.month, 1))
        return n if n > t else at8(date(t.year + (t.month == 12), t.month % 12 + 1, 1))
    if freq == "Quarterly":
        for y in (t.year, t.year + 1):
            for m in (1, 4, 7, 10):
                n = at8(date(y, m, 1))
                if n > t:
                    return n
    raise HTTPException(422, "Unknown frequency")


def _sched_dict(s: Optional[ReportSchedule]) -> Optional[dict]:
    if not s:
        return None
    return {"id": s.id, "frequency": s.frequency, "format": s.fmt, "period": s.period, "recipients": s.recipients or [], "active": bool(s.is_active),
            "next_run": s.next_run_at.isoformat(timespec="minutes") if s.next_run_at else None,
            "last_run": s.last_run_at.isoformat(timespec="minutes") if s.last_run_at else None, "last_status": s.last_status, "last_error": s.last_error}


def parse_recipients(raw: str) -> list[str]:
    out = []
    for a in re.split(r"[,;\s]+", raw or ""):
        a = a.strip()
        if not a:
            continue
        if not EMAIL_RE.match(a) or len(a) > 254:
            raise HTTPException(422, f"'{a}' is not a valid e-mail address")
        if a.lower() not in {x.lower() for x in out}:
            out.append(a)
    if not out:
        raise HTTPException(422, "Add at least one recipient")
    if len(out) > 25:
        raise HTTPException(422, "At most 25 recipients")
    return out


def save_schedule(db: Session, cu: User, key: str, b: Any) -> dict[str, Any]:
    ensure_schema(db)
    if not user_has_permission(db, cu, "reports.schedule"):
        raise HTTPException(403, "You don't have permission to schedule reports")
    d = definition(db, cu, key)
    if b.frequency not in FREQUENCIES:
        raise HTTPException(422, "Choose a frequency")
    if b.format not in FORMATS:
        raise HTTPException(422, "Choose a format")
    if b.period not in PERIODS:
        raise HTTPException(422, "Unknown reporting period")
    rec = parse_recipients(b.recipients)
    s = db.query(ReportSchedule).filter(ReportSchedule.user_id == cu.id, ReportSchedule.report_key == key).with_for_update().first()
    if not s:
        s = ReportSchedule(user_id=cu.id, report_key=key)
        db.add(s)
    s.report_name, s.frequency, s.fmt, s.period, s.recipients = d["n"][:200], b.frequency, b.format, b.period, rec
    s.is_active, s.next_run_at, s.failures, s.updated_at = True, next_run(b.frequency), 0, now_ist()
    _audit(db, cu, "schedule", f"Report scheduled: {d['n']} – {b.frequency}, {b.format} to {', '.join(rec)}")
    db.commit()
    return _sched_dict(s)


def remove_schedule(db: Session, cu: User, key: str) -> dict[str, Any]:
    ensure_schema(db)
    s = db.query(ReportSchedule).filter(ReportSchedule.user_id == cu.id, ReportSchedule.report_key == key).first()
    if not s:
        raise HTTPException(404, "This report has no schedule")
    name = s.report_name
    db.delete(s)
    _audit(db, cu, "unschedule", f"Report schedule removed: {name}")
    db.commit()
    return {"removed": True}


def _audit(db: Session, cu: User, action: str, text_: str) -> None:
    try:
        from app.models.all_models import ActivityLog
        db.add(ActivityLog(user_id=cu.id, module="reports", record_id=0, action=action, description=text_[:500], icon="📊", color="#EFF6FF"))
    except Exception:
        pass


# ─── exports ──────────────────────────────────────────────────────────────────

def _inr(v: Any) -> str:
    try:
        n = float(v or 0)
    except (TypeError, ValueError):
        return str(v)
    s = f"{abs(n):,.2f}"
    whole, frac = s.split(".")
    digits = whole.replace(",", "")
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        head = ",".join([head[max(0, i - 2):i] for i in range(len(head), 0, -2)][::-1])
        whole = f"{head},{tail}"
    return f"{'-' if n < 0 else ''}₹{whole}.{frac}" if frac != "00" else f"{'-' if n < 0 else ''}₹{whole}"


def _date(v: Any) -> str:
    d = RD._day(v)
    return d.strftime("%d %b %Y") if d else ""


def cell(c: dict, r: dict) -> str:
    v = r.get(c["k"])
    f = c.get("f")
    if c["k"] == "jid" and f == "journey":
        steps = ((r.get("journey") or {}).get("steps") or [])
        return f"{v or ''} {''.join('●' if s.get('done') else '○' for s in steps)}".strip()
    if f == "result":
        return "Success" if r.get("ok") else (r.get("why") or "Failed")
    if v is None or v == "":
        return "—" if f in ("inr", "int", "num", "pct", "bar") else ""
    if f == "inr":
        return _inr(v)
    if f in ("d", "date"):
        return _date(v)
    if f in ("pct", "bar"):
        return f"{v}%"
    if f == "num":
        try:
            return f"{float(v):,.1f}".rstrip("0").rstrip(".")
        except (TypeError, ValueError):
            return str(v)
    return str(v)


def kpi_text(k: dict) -> str:
    v, f = k.get("v"), k.get("f")
    if v is None or v == "":
        return "—"
    if f == "inr":
        return _inr(v)
    if f == "pct":
        return f"{v}%"
    return str(v)


def table(out: dict) -> tuple[list[str], list[list[str]], list[str]]:
    cols = out["cols"]
    rows = [[cell(c, r) for c in cols] for r in out["rows"]]
    totals = []
    if any(c.get("sum") for c in cols) and out["rows"]:
        for i, c in enumerate(cols):
            if c.get("sum"):
                s = sum((RD.D(r.get(c["k"])) for r in out["rows"]), Decimal(0))
                totals.append(_inr(s) if c.get("f") == "inr" else f"{s:,}")
            else:
                totals.append(f"Σ {len(out['rows'])} rows" if i == 0 else "")
    return [c["t"] for c in cols], rows, totals


def header_lines(out: dict) -> list[str]:
    return [out["n"], f"{out['cat']} · {out['company']} · {out['period_label']} ({_date(out['start'])} – {_date(out['end'])})",
            f"Generated {datetime.fromisoformat(out['generated']).strftime('%d %b %Y %H:%M')} IST"
            + (f" · Period applies to: {out['basis']}" if out.get("basis") else " · Period: not date-based") + (f" · {out['note']}" if out.get("note") else ""),
            "KPIs: " + " · ".join(f"{k['l']} {kpi_text(k)}" for k in out["k"])]


def to_csv(out: dict) -> bytes:
    h, rows, tot = table(out)
    buf = io.StringIO()
    w = csv.writer(buf)
    for line in header_lines(out):
        w.writerow([line])
    w.writerow([])
    w.writerow(h)
    w.writerows(rows)
    if tot:
        w.writerow(tot)
    return ("﻿" + buf.getvalue()).encode("utf-8")


def to_xlsx(out: dict) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    wb = Workbook()
    ws = wb.active
    ws.title = re.sub(r"[\[\]:*?/\\]", "", out["n"])[:31] or "Report"
    lines = header_lines(out)
    ws.append([lines[0]]); ws["A1"].font = Font(bold=True, size=14)
    for ln in lines[1:]:
        ws.append([ln])
    ws.append([])
    cols = out["cols"]
    ws.append([c["t"] for c in cols])
    hr = ws.max_row
    for i in range(1, len(cols) + 1):
        c = ws.cell(row=hr, column=i)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="0F6E8C")
    for r in out["rows"]:
        vals = []
        for c in cols:
            v = r.get(c["k"])
            if c.get("f") in ("inr", "int", "num") and isinstance(v, (int, float, Decimal)) and not isinstance(v, bool):
                vals.append(float(v))
            elif c.get("f") in ("d", "date"):
                d = RD._day(v)
                vals.append(d if d else "")
            else:
                vals.append(cell(c, r))
        ws.append(vals)
    for i, c in enumerate(cols, start=1):
        letter = get_column_letter(i)
        if c.get("f") == "inr":
            for row in ws.iter_rows(min_row=hr + 1, min_col=i, max_col=i):
                row[0].number_format = '"₹"#,##,##0.00'
        elif c.get("f") in ("d", "date"):
            for row in ws.iter_rows(min_row=hr + 1, min_col=i, max_col=i):
                row[0].number_format = "dd mmm yyyy"
        if c.get("r"):
            for row in ws.iter_rows(min_row=hr, min_col=i, max_col=i):
                row[0].alignment = Alignment(horizontal="right")
        ws.column_dimensions[letter].width = max(10, min(48, int((c.get("w") or 140) / 7)))
    _, _, tot = table(out)
    if tot:
        ws.append(tot)
        for cc in ws[ws.max_row]:
            cc.font = Font(bold=True)
    ws.freeze_panes = ws.cell(row=hr + 1, column=1)
    b = io.BytesIO()
    wb.save(b)
    return b.getvalue()


def _pdf_text(s: str) -> str:
    s = (s or "").replace("₹", "Rs ").replace("●", "*").replace("○", "o").replace("–", "-").replace("—", "-").replace("·", "-").replace("Σ", "Total") \
        .replace("≤", "<=").replace("’", "'").replace("“", '"').replace("”", '"').replace("🔒", "")
    s = s.encode("latin-1", "replace").decode("latin-1")
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def to_pdf(out: dict) -> bytes:
    """Landscape A4 table PDF with the standard Helvetica fonts (no external library)."""
    W, H, M = 842, 595, 28
    h, rows, tot = table(out)
    widths = [max(50, min(260, int(c.get("w") or (112 if c.get("f") == "inr" else 122 if c.get("f") in ("d", "date") else 100)))) for c in out["cols"]]
    scale = min(1.0, (W - 2 * M) / max(sum(widths), 1))
    widths = [w * scale for w in widths]
    fs = 7.5 if scale < .8 else 8
    char_w = fs * 0.5

    def fit(s: str, w: float) -> str:
        n = max(1, int((w - 6) / char_w))
        return s if len(s) <= n else s[: max(1, n - 1)] + "~"

    pages: list[list[str]] = []
    ops: list[str] = []
    y = 0.0

    def new_page():
        nonlocal ops, y
        ops = []
        pages.append(ops)
        y = H - M
        for i, ln in enumerate(header_lines(out)):
            size = 14 if i == 0 else 8
            ops.append(f"BT /{'F2' if i == 0 else 'F1'} {size} Tf {M} {y - size:.1f} Td ({_pdf_text(ln[:190])}) Tj ET")
            y -= size + 4
        y -= 4
        draw_row(h, bold=True, fill=True)

    def draw_row(vals: list[str], bold: bool = False, fill: bool = False):
        nonlocal y
        rh = fs + 6
        if fill:
            ops.append(f"0.059 0.431 0.549 rg {M} {y - rh:.1f} {W - 2 * M:.1f} {rh:.1f} re f 1 1 1 rg")
        x = M
        for i, v in enumerate(vals):
            txt = _pdf_text(fit(v, widths[i]))
            right = out["cols"][i].get("r") if i < len(out["cols"]) else False
            tx = x + widths[i] - 3 - len(fit(v, widths[i])) * char_w if right else x + 3
            ops.append(f"BT /{'F2' if bold else 'F1'} {fs} Tf {tx:.1f} {y - rh + 4:.1f} Td ({txt}) Tj ET")
            x += widths[i]
        if fill:
            ops.append("0 0 0 rg")
        else:
            ops.append(f"0.85 0.87 0.9 RG 0.4 w {M} {y - rh:.1f} m {W - M:.1f} {y - rh:.1f} l S")
        y -= rh

    new_page()
    if not rows:
        ops.append(f"BT /F1 9 Tf {M} {y - 14:.1f} Td (No records for this period) Tj ET")
    for r in rows:
        if y < M + 20:
            new_page()
        draw_row(r)
    if tot:
        if y < M + 20:
            new_page()
        draw_row(tot, bold=True)
    for i, p in enumerate(pages):
        p.append(f"BT /F1 7 Tf {W - M - 60} 14 Td (Page {i + 1} of {len(pages)}) Tj ET")

    objs: list[bytes] = []
    def add(b: bytes) -> int:
        objs.append(b)
        return len(objs)
    add(b"")  # 1 catalog placeholder
    add(b"")  # 2 pages placeholder
    f1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    f2 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    kids = []
    for p in pages:
        data = zlib.compress("\n".join(p).encode("latin-1", "replace"))
        c = add(b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(data) + data + b"\nendstream")
        kids.append(add(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] /Resources << /Font << /F1 {f1} 0 R /F2 {f2} 0 R >> >> /Contents {c} 0 R >>".encode()))
    objs[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>".encode()
    title = _pdf_text(out["n"]).encode("latin-1", "replace")
    info = add(b"<< /Title (" + title + b") /Producer (Azcentrix Connect Reports) >>")
    buf = io.BytesIO()
    buf.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for i, o in enumerate(objs, start=1):
        offs.append(buf.tell())
        buf.write(f"{i} 0 obj\n".encode() + o + b"\nendobj\n")
    x = buf.tell()
    buf.write(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for o in offs:
        buf.write(f"{o:010d} 00000 n \n".encode())
    buf.write(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R /Info {info} 0 R >>\nstartxref\n{x}\n%%EOF\n".encode())
    return buf.getvalue()


MIME = {"PDF": ("pdf", "application/pdf"), "Excel": ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "CSV": ("csv", "text/csv")}


def render(db: Session, cu: User, key: str, period: str, fmt: str) -> tuple[bytes, str, str, dict]:
    if fmt not in FORMATS:
        raise HTTPException(422, "Choose PDF, Excel or CSV")
    out = run(db, cu, key, period, row_cap=MAX_EXPORT_ROWS)
    data = {"PDF": to_pdf, "Excel": to_xlsx, "CSV": to_csv}[fmt](out)
    ext, mime = MIME[fmt]
    name = f"{re.sub(r'[^A-Za-z0-9]+', '_', out['n']).strip('_')}_{out['period']}_{today_ist().strftime('%Y%m%d')}.{ext}"
    return data, name, mime, out


def export(db: Session, cu: User, key: str, period: str, fmt: str) -> tuple[bytes, str, str]:
    if not user_has_permission(db, cu, "reports.export"):
        raise HTTPException(403, "You don't have permission to export reports")
    data, name, mime, out = render(db, cu, key, period, fmt)
    db.add(ReportRun(report_key=key, report_name=out["n"][:200], user_id=cu.id, trigger="export", fmt=fmt, period=period, rows=out["total"],
                     file_name=name, file_size_kb=max(1, len(data) // 1024), status="ok"))
    db.commit()
    return data, name, mime


def email_file(db: Session, cu: User, key: str, period: str, fmt: str, request: Request) -> dict[str, Any]:
    """Generate the report, store it in Document Hub (owner = user) and return the composer pre-fill with the attachment."""
    if not user_has_permission(db, cu, "reports.share"):
        raise HTTPException(403, "You don't have permission to e-mail reports")
    if not user_has_permission(db, cu, "document_management.view"):
        raise HTTPException(403, "Attaching a report needs Document Hub access – export it instead")
    import os
    from app.core.config import settings
    from app.models.all_models import DocumentManagementFile
    from app.routers.document_management_router import _standalone_document_id
    from app.utils.file_storage import media_slug_from_request, save_upload_optimized
    data, name, mime, out = render(db, cu, key, period, fmt)
    saved = save_upload_optimized(root_dir=os.path.abspath(settings.MEDIA_ROOT), subfolder="document-management", original_filename=name,
                                  contents=data, media_slug=media_slug_from_request(request), content_type=mime)
    doc = DocumentManagementFile(name=name[:300], description=f"{out['n']} – {out['period_label']} (generated {out['generated'].replace('T', ' ')})"[:500],
                                 file_url=saved.url, file_size_kb=saved.size_kb, uploaded_by=cu.id, doc_type="Report")
    db.add(doc)
    db.flush()
    ref = f"RPT-{today_ist().strftime('%Y%m%d')}-{doc.id}"
    db.add(ReportRun(report_key=key, report_name=out["n"][:200], user_id=cu.id, trigger="email", fmt=fmt, period=period, rows=out["total"], file_name=name,
                     file_url=saved.url, file_size_kb=saved.size_kb, document_id=doc.id, status="ok"))
    db.commit()
    gen = datetime.fromisoformat(out["generated"]).strftime("%d %b %Y %H:%M")
    return {"attachment": {"key": f"doc:{_standalone_document_id(doc)}", "name": name}, "subject": f"{out['n']} – report",
            "body": f"Hi,\n\nPlease find the \"{out['n']}\" report attached ({out['period_label']}, {out['company']}).\nReport reference: {ref}\n"
                    f"Generated: {gen} IST\n\nRegards,\n{cu.full_name}", "reference": ref}


def history(db: Session, cu: User, key: Optional[str]) -> list[dict]:
    ensure_schema(db)
    q = db.query(ReportRun).filter(ReportRun.user_id == cu.id)
    if key:
        q = q.filter(ReportRun.report_key == key)
    return [{"id": r.id, "key": r.report_key, "name": r.report_name, "trigger": r.trigger, "fmt": r.fmt, "period": r.period, "rows": r.rows,
             "file": r.file_name, "recipients": r.recipients, "status": r.status, "error": r.error, "at": r.created_at.isoformat(timespec="minutes") if r.created_at else None}
            for r in q.order_by(ReportRun.id.desc()).limit(100).all()]


# ─── scheduled execution (platform job "report_schedules") ────────────────────

def run_due_schedules() -> dict[str, int]:
    from app.database import MasterSessionLocal
    from app.models.tenant import Tenant
    sent = failed = 0
    for slug, db in _tenant_sessions():
        try:
            ensure_schema(db)
            now = now_ist()
            due = db.query(ReportSchedule).filter(ReportSchedule.is_active == True, ReportSchedule.next_run_at <= now).limit(50).all()
            if not due:
                continue
            m = MasterSessionLocal()
            try:
                tenant = m.query(Tenant).filter(Tenant.slug == slug).first()
            finally:
                m.close()
            for s in due:
                ok = _deliver(db, tenant, s)
                sent += ok
                failed += not ok
        except Exception as exc:
            logger.warning("report schedules for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()
    return {"sent": sent, "failed": failed}


def _deliver(db: Session, tenant, s: ReportSchedule) -> bool:
    old = s.next_run_at
    nxt = next_run(s.frequency, max(now_ist(), old or now_ist()))
    claimed = db.execute(update(ReportSchedule).where(ReportSchedule.id == s.id, ReportSchedule.next_run_at == old, ReportSchedule.is_active == True)
                         .values(next_run_at=nxt)).rowcount
    db.commit()
    if not claimed:                      # another worker took it
        return True
    db.refresh(s)
    err = None
    name, data = None, b""
    try:
        owner = db.query(User).filter(User.id == s.user_id, User.is_active == True).first()
        if not owner:
            raise HTTPException(403, "The schedule owner is no longer active")
        if not user_has_permission(db, owner, "reports.schedule"):
            raise HTTPException(403, "The schedule owner may no longer schedule reports")
        data, name, mime, out = render(db, owner, s.report_key, s.period, s.fmt)
        if tenant is None:
            raise RuntimeError("Workspace not found")
        from app.services.tenant_email_service import send_tenant_email
        gen = datetime.fromisoformat(out["generated"]).strftime("%d %b %Y %H:%M")
        try:
            send_tenant_email(tenant, ", ".join(s.recipients or []), f"{out['n']} – {out['period_label']}",
                          f"Hi,\n\nAttached is your scheduled report \"{out['n']}\" ({s.frequency}, {out['period_label']}, {out['company']}).\n"
                          f"Generated: {gen} IST · {out['total']} rows.\n\nSent on behalf of {owner.full_name} by Azcentrix Connect.",
                          attachments=[(name, data, mime)])
        except Exception as mail_exc:
            raise RuntimeError(f"E-mail delivery failed: {mail_exc}") from mail_exc
    except HTTPException as exc:
        err = str(exc.detail)
    except Exception as exc:
        err = str(exc)[:480] or exc.__class__.__name__
    s.last_run_at = now_ist()
    if err:
        s.failures = (s.failures or 0) + 1
        s.last_status, s.last_error = "failed", err[:500]
        if s.failures < 3:
            s.next_run_at = now_ist() + timedelta(minutes=30)     # retry the same delivery
    else:
        s.failures, s.last_status, s.last_error = 0, "sent", None
    db.add(ReportRun(report_key=s.report_key, report_name=s.report_name, user_id=s.user_id, schedule_id=s.id, trigger="schedule", fmt=s.fmt, period=s.period,
                     file_name=name, file_size_kb=max(1, len(data) // 1024) if data else None, recipients=", ".join(s.recipients or [])[:2000],
                     status="failed" if err else "sent", error=(err or None) and err[:500]))
    db.commit()
    return not err
