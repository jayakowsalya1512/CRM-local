"""Commitments (prototype v18 · Field Sales 360 → Commitments and Dashboard → Commitments).

One dataset (commitments / commitment_entries) and one calculation path, used by the Dashboard, the Field Sales 360
Overview, the person view, the commitment drawer and the Weekly report. Nothing is generated or estimated.

People        – active users inside the caller's KAM Data Visibility (same rule as Field Sales 360) whose role is one of
                the roles that give commitments (Settings → Rules): KAM (sales roles, as Field Sales 360), Sales Head
                (role manager / sales_head), Bid Manager (tender roles).
Achievements  – read from the source modules for the owner (a Sales Head's team commitment: the members of the teams
                they lead), only up to today:
                · Leads generated   – leads created (leads with a lead reference), owner = assigned to / created by
                · Deals converted   – deals whose pipeline stage is Won, won within the window (Deals module rule)
                · Quotes sent       – quotes whose latest revision is past Draft, dated by that revision
                · Bids submitted    – tenders whose submission date is in the window and whose stage has reached the
                                      flow's submission stage (or Won / Lost after evaluation); owner = bid owner or the
                                      customer's KAM
                · Orders booked     – work orders (not Draft / Cancelled / Lost) by PO date, owner = customer's KAM or PM
                · Payments collected– order_payment_receipts acknowledged by Finance, by the person who collected them;
                                      Pending finance receipts are reported separately and never counted as collected
Pro-rata      – a commitment counts in a window by the share of its days that fall in the window (actual days in the
                period), using the most granular period type the person committed for that type.
Score         – average of the achievement % of each type with a commitment > 0, each capped at 150%.
"""
from __future__ import annotations

import logging
import re
import threading
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Optional

from fastapi import HTTPException, Request
from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.timezone import now_ist, today_ist
from app.dependencies import get_request_ip, user_has_permission
from app.models.all_models import Customer, Lead, LeadSource, Quotation, Tender, User, WOMilestone, WorkOrder
from app.models.commitments import (COMMITMENT_TABLES, PERIODS, RECEIPT_STATUSES, Commitment, CommitmentEntry, CommitmentSetting,
                                    CommitmentTeam, CommitmentTeamMember, OrderPaymentReceipt)

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()
MODULE = "commitments"

# prototype CMT_ALL – mod = the Process Designer object the type depends on ('' = always offered)
CMT_ALL: list[dict[str, Any]] = [
    {"k": "lead", "n": "Leads generated", "s": "leads", "mod": "leads", "ic": "funnel", "h": "New leads you will create"},
    {"k": "deal", "n": "Deals converted", "s": "deals won", "mod": "opps", "ic": "target", "h": "Deals you expect to win"},
    {"k": "quote", "n": "Quotes sent", "s": "quotes", "mod": "quotes", "ic": "doc", "h": "Quotations you will send"},
    {"k": "bid", "n": "Bids submitted", "s": "bids", "mod": "tenders", "ic": "file", "h": "Tenders you will submit"},
    {"k": "order", "n": "Orders booked", "s": "orders", "mod": "wo", "ic": "brief", "h": "Orders you expect to book"},
    {"k": "pay", "n": "Payments collected", "s": "collected", "mod": "", "ic": "wallet", "money": True,
     "h": "Payments you will collect – against a customer and a tender"},
]
MOD_LABEL = {"leads": "Leads", "opps": "Deals", "quotes": "Quotes", "tenders": "Bids & Tenders", "wo": "Orders & Projects"}
PRANK = {"Week": 0, "Month": 1, "Quarter": 2, "Half-year": 3, "Year": 4}
ROLES = ("KAM", "Sales Head", "Bid Manager")
CUTOFFS = ("Monday 11:00", "Monday 18:00", "Friday 17:00 (for next week)", "Sunday 20:00")
DEFAULTS: dict[str, Any] = {"types": {}, "cutoff": "Monday 11:00", "periods": list(PERIODS), "roles": ["KAM", "Sales Head"],
                            "pay_tender": True, "remind": True}
FLOWP = [("Lead → Tender → Order", {"leads": 1, "opps": 0, "tenders": 1, "quotes": 0, "wo": 1}),
         ("Lead → Deal → Quotation → Order", {"leads": 1, "opps": 1, "tenders": 0, "quotes": 1, "wo": 1}),
         ("Lead → Deal → Tender → Order", {"leads": 1, "opps": 1, "tenders": 1, "quotes": 0, "wo": 1}),
         ("Lead → Deal → Tender / Quotation → Order", {"leads": 1, "opps": 1, "tenders": 1, "quotes": 1, "wo": 1})]
TENDER_ROLES = {"tender", "tenders", "tender_team", "tendering", "tender_executive", "tender_manager", "bid_manager", "bid_team"}
HEAD_ROLES = {"manager", "sales_head", "saleshead"}
SETTINGS_ROLES = {"manager", "sales_head", "admin", "super_admin", "ceo"}
SCORE_CAP = 150


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        for t in COMMITMENT_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        try:   # v18 receipt columns (stage link, maker, Finance details) used by Orders & Projects → Collections & finance
            from app.services.order_payment_service import ensure_receipt_schema
            ensure_receipt_schema(db)
        except Exception as exc:
            db.rollback()
            logger.warning("commitments: order payment schema skipped: %s", exc)
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
            logger.warning("commitments schema: tenant %s unavailable: %s", slug, exc)
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
        except Exception as exc:
            logger.warning("commitments schema for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()


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


def pct(a: float, b: float) -> int:
    return round(a / b * 100) if b else 0


def parse_day(v: Any, what: str = "date") -> date:
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except (TypeError, ValueError):
        raise HTTPException(422, f"Enter a valid {what}")


def wk_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def wk_no(d: date) -> int:
    return d.isocalendar()[1]


def fd_s(d: date) -> str:
    return f"{d.day} {d.strftime('%b')}"


def _month_end(y: int, m: int) -> date:
    return (date(y + (m // 12), m % 12 + 1, 1)) - timedelta(days=1)


def _add_months(y: int, m: int, k: int) -> tuple[int, int]:
    t = y * 12 + (m - 1) + k
    return t // 12, t % 12 + 1


def per_of(per: str, d: date, m0: int = 4) -> dict[str, Any]:
    """Period containing d (prototype perOf) – fiscal quarters / halves / year start in month m0."""
    if per == "Week":
        a = wk_start(d)
        b = a + timedelta(days=6)
        label = f"Wk {wk_no(a)} · {fd_s(a)} – {fd_s(b)}"
    elif per == "Month":
        a, b = date(d.year, d.month, 1), _month_end(d.year, d.month)
        label = a.strftime("%B %Y")
    else:
        fy = d.year if d.month >= m0 else d.year - 1
        off = (d.month - m0) % 12
        fyl = f"FY{str(fy + 1)[2:]}"
        if per == "Quarter":
            q = off // 3
            sy, sm = _add_months(fy, m0, q * 3)
            ey, em = _add_months(sy, sm, 2)
            a, b = date(sy, sm, 1), _month_end(ey, em)
            label = f"Q{q + 1} {fyl} · {a.strftime('%b')}–{b.strftime('%b')}"
        elif per == "Half-year":
            h = 0 if off < 6 else 1
            sy, sm = _add_months(fy, m0, h * 6)
            ey, em = _add_months(sy, sm, 5)
            a, b = date(sy, sm, 1), _month_end(ey, em)
            label = f"H{h + 1} {fyl} · {a.strftime('%b')}–{b.strftime('%b')}"
        elif per == "Year":
            ey, em = _add_months(fy, m0, 11)
            a, b = date(fy, m0, 1), _month_end(ey, em)
            label = f"FY {fy}" if m0 == 1 else f"FY {fy}-{str(fy + 1)[2:]}"
        else:
            raise HTTPException(422, "Unknown period type")
    return {"per": per, "from": a, "to": b, "label": label, "days": (b - a).days + 1}


def per_shift(p: dict[str, Any], n: int, m0: int) -> dict[str, Any]:
    return per_of(p["per"], p["to"] + timedelta(days=1) if n > 0 else p["from"] - timedelta(days=1), m0)


def per_json(p: dict[str, Any]) -> dict[str, Any]:
    return {"per": p["per"], "from": iso(p["from"]), "to": iso(p["to"]), "label": p["label"], "days": p["days"]}


def per_options(per: str, m0: int, anchor: Optional[date] = None) -> list[dict[str, Any]]:
    """prototype cmPerOpts: Week → last, this and the next two weeks; longer periods → this and the next one."""
    c = per_of(per, today_ist(), m0)
    L = [per_shift(c, -1, m0), c, per_shift(c, 1, m0), per_shift(per_shift(c, 1, m0), 1, m0)] if per == "Week" else [c, per_shift(c, 1, m0)]
    if anchor:
        pa = per_of(per, anchor, m0)
        if not any(p["from"] == pa["from"] for p in L):
            L.insert(0, pa)
    out = []
    for p in L:
        tag = " · current" if p["from"] == c["from"] else " · previous" if p["from"] < c["from"] else ""
        out.append({**per_json(p), "opt": p["label"] + tag})
    return out


def weeks_back(n: int, end: Optional[date] = None) -> list[date]:
    c = wk_start(end or today_ist())
    return [c - timedelta(days=7 * (n - 1 - i)) for i in range(n)]


def fy_start_month(db: Session) -> int:
    from app.models.all_models import Setting
    try:
        v = db.query(Setting.value).filter(Setting.key == "fiscal_year_start").scalar()
        m0 = int(v or 4)
    except (TypeError, ValueError):
        m0 = 4
    return m0 if 1 <= m0 <= 12 else 4


def normal_role(role: Any) -> str:
    return str(role or "").strip().lower().replace("-", "_").replace(" ", "_")


def role_cat(role: Any) -> Optional[str]:
    from app.routers.kam_router import _is_kam_sales_role
    r = normal_role(role)
    if r in HEAD_ROLES:
        return "Sales Head"
    if r in TENDER_ROLES:
        return "Bid Manager"
    return "KAM" if _is_kam_sales_role(role) else None


# ─── settings / business flow ─────────────────────────────────────────────────

def settings(db: Session) -> dict[str, Any]:
    out = {k: (dict(v) if isinstance(v, dict) else list(v) if isinstance(v, list) else v) for k, v in DEFAULTS.items()}
    for r in db.query(CommitmentSetting).all():
        if r.key in out and r.value is not None:
            out[r.key] = r.value
    if out["cutoff"] not in CUTOFFS:
        out["cutoff"] = DEFAULTS["cutoff"]
    out["periods"] = [p for p in PERIODS if p in (out["periods"] or [])] or ["Week"]
    out["roles"] = [r for r in ROLES if r in (out["roles"] or [])]
    out["types"] = {k: bool(v) for k, v in (out["types"] or {}).items() if k in {t["k"] for t in CMT_ALL}}
    out["pay_tender"], out["remind"] = bool(out["pay_tender"]), bool(out["remind"])
    return out


def flow_objects(db: Session) -> dict[str, bool]:
    """Process Designer → Sales flow objects switched on for the company (missing = on, as Process Designer reads it)."""
    try:
        from app.models.process import ProcessConfig
        row = db.get(ProcessConfig, "objects")
        val = (row.value if row else None) or {}
    except Exception as exc:
        db.rollback()
        logger.warning("commitments: process objects unavailable: %s", exc)
        val = {}
    return {k: val.get(k) is not False for k in MOD_LABEL}


def flow_label(objs: dict[str, bool]) -> str:
    return next((n for n, m in FLOWP if all(bool(m[k]) == objs[k] for k in m)), "Custom flow")


def types_on(cfg: dict[str, Any], objs: dict[str, bool]) -> list[dict[str, Any]]:
    return [t for t in CMT_ALL if (not t["mod"] or objs.get(t["mod"], True)) and cfg["types"].get(t["k"]) is not False]


def can_settings(db: Session, cu: User) -> bool:
    from app.utils.data_scope import get_module_data_scope
    if not user_has_permission(db, cu, "kam.update"):
        return False
    return normal_role(cu.role) in SETTINGS_ROLES or get_module_data_scope(db, cu, "kam") == "all"


def save_settings(db: Session, cu: User, patch: dict[str, Any], request: Optional[Request]) -> dict[str, Any]:
    if not can_settings(db, cu):
        raise HTTPException(403, "Only a Sales Head or administrator can change commitment settings")
    cur = settings(db)
    clean: dict[str, Any] = {}
    if "types" in patch:
        clean["types"] = {k: bool(v) for k, v in (patch["types"] or {}).items() if k in {t["k"] for t in CMT_ALL}}
    if "periods" in patch:
        clean["periods"] = [p for p in PERIODS if p in (patch["periods"] or [])] or ["Week"]
    if "roles" in patch:
        clean["roles"] = [r for r in ROLES if r in (patch["roles"] or [])]
    if "cutoff" in patch:
        if patch["cutoff"] not in CUTOFFS:
            raise HTTPException(422, "Unknown weekly cut-off")
        clean["cutoff"] = patch["cutoff"]
    for k in ("pay_tender", "remind"):
        if k in patch:
            clean[k] = bool(patch[k])
    for k, v in clean.items():
        row = db.get(CommitmentSetting, k)
        if row is None:
            db.add(CommitmentSetting(key=k, value=v, updated_by=cu.id))
        else:
            row.value, row.updated_by = v, cu.id
    db.commit()
    _audit(db, cu, request, "update", None, "Commitment settings changed", {k: cur.get(k) for k in clean}, clean)
    return settings(db)


# ─── people & teams ───────────────────────────────────────────────────────────

def scope_uids(db: Session, cu: User) -> list[int]:
    from app.routers.kam_router import _get_team_uids
    return [int(u) for u in (_get_team_uids(cu, db) or []) if u]


def teams(db: Session) -> list[dict[str, Any]]:
    T = db.query(CommitmentTeam).order_by(CommitmentTeam.sort_order, CommitmentTeam.id).all()
    mem: dict[int, list[int]] = defaultdict(list)
    for m in db.query(CommitmentTeamMember).all():
        mem[int(m.team_id)].append(int(m.user_id))
    return [{"id": t.id, "name": t.name, "lead_id": t.lead_id, "members": mem.get(t.id, [])} for t in T]


class People:
    """Everyone the caller may see who gives commitments, with team and Sales Head roll-up."""

    def __init__(self, db: Session, cu: User, cfg: dict[str, Any]):
        self.cfg = cfg
        self.teams = teams(db)
        self.team_of: dict[int, dict] = {m: t for t in self.teams for m in t["members"]}
        uids = scope_uids(db, cu)
        rows = db.query(User).filter(User.id.in_(uids or [-1]), User.is_active == True).order_by(User.full_name).all()  # noqa: E712
        roles = set(cfg["roles"])
        self.all_names = {u.id: u.full_name or u.username or f"User {u.id}" for u in rows}
        self.list: list[dict[str, Any]] = []
        for u in rows:
            cat = role_cat(u.role)
            if cat and cat in roles:
                self.list.append({"id": u.id, "name": self.all_names[u.id], "cat": cat, "head": cat == "Sales Head",
                                  "manager_id": u.reporting_manager_id})
        self.by_id = {p["id"]: p for p in self.list}
        self.ids = [p["id"] for p in self.list]
        heads = [p["id"] for p in self.list if p["head"]]
        self._members: dict[int, list[int]] = {}
        for h in heads:
            led = [m for t in self.teams if t["lead_id"] == h for m in t["members"]]
            if not led and len(heads) == 1:                 # one Sales Head: their team commitment covers every team
                led = [m for t in self.teams for m in t["members"]]
            self._members[h] = [m for m in dict.fromkeys(led) if m != h]

    def team(self, uid: int) -> str:
        p = self.by_id.get(uid)
        if p and p["head"]:
            return "Sales leadership"
        t = self.team_of.get(uid)
        return t["name"] if t else "Unassigned"

    def team_id(self, uid: int) -> Optional[int]:
        t = self.team_of.get(uid)
        return t["id"] if t else None

    def members(self, head: int) -> list[int]:
        return self._members.get(head, [])

    def W(self, uid: int) -> list[int]:
        p = self.by_id.get(uid)
        return self.members(uid) if p and p["head"] else [uid]

    def owners(self) -> set[int]:
        s = set(self.ids)
        for h in self._members.values():
            s.update(h)
        return s


def annual_targets(db: Session, uids: Iterable[int]) -> dict[int, float]:
    from app.services import field_sales_service as FS
    ids = sorted({int(u) for u in uids})
    if not ids:
        return {}
    FS.ensure_schema(db)
    fy = FS.fiscal_year(db)
    return {u: v["target"] for u, v in FS.targets(db, ids, fy).items()}


# ─── achievement sources (one load per window) ───────────────────────────────

class Ev:
    __slots__ = ("d", "own", "v", "pend", "ref")

    def __init__(self, d: date, own: set[int], v: float, pend: bool = False, ref: Optional[dict] = None):
        self.d, self.own, self.v, self.pend, self.ref = d, own, v, pend, ref


def _customer_kams(db: Session, cids: Iterable[Optional[int]]) -> dict[int, int]:
    ids = {int(c) for c in cids if c}
    if not ids:
        return {}
    try:
        from app.services import customer360_service as CS
        CS.ensure_schema(db)
        fam, P = CS.Family(db), CS.profiles(db)
        out = {}
        for c in ids:
            k = fam.kam(c, P)[0]
            if k:
                out[c] = int(k)
        return out
    except Exception as exc:
        db.rollback()
        logger.warning("commitments: customer KAMs via Customer 360 unavailable (%s) – using the customer owner", exc)
        return {int(r.id): int(r.assigned_to) for r in db.query(Customer.id, Customer.assigned_to).filter(Customer.id.in_(ids)).all() if r.assigned_to}


def _bid_submitted(db: Session, tenders: list[Tender]) -> dict[int, bool]:
    """Tender → has it reached its flow's submission stage (Tender & bid flows, Process Designer)."""
    if not tenders:
        return {}
    from app.services import bid_service as BS
    try:
        BS.ensure_schema(db)
    except Exception:
        db.rollback()
    fl = BS.flows(db, include_inactive=True)
    _, cur = BS.sync(db, tenders, fl)
    sub_pos = {}
    for fw in fl:
        hit = next((s for s in fw["stages"] if s["kind"] == "open" and re.search(r"submi", s["name"], re.I)), None)
        sub_pos[fw["key"]] = hit["position"] if hit else None
    out = {}
    for t in tenders:
        s = cur.get(t.id)
        if not s:
            out[t.id] = (t.tender_status or "") in ("Submitted", "Evaluation", "Reverse Auction") or t.result == "Won"
            continue
        if s["kind"] == "won":
            out[t.id] = True
        elif s["kind"] == "lost":
            out[t.id] = t.result == "Lost"
        else:
            sp = sub_pos.get(s.get("flow"))
            out[t.id] = sp is not None and s["position"] >= sp
    return out


class Sources:
    """Achievement events for owners U in [a, b] (dates up to today count as achieved)."""

    def __init__(self, db: Session, U: set[int], a: date, b: date, objs: dict[str, bool]):
        self.db, self.a, self.b, self.today = db, a, b, today_ist()
        self.ev: dict[str, list[Ev]] = {t["k"]: [] for t in CMT_ALL}
        self.receipts: list[OrderPaymentReceipt] = []
        U = {int(u) for u in U}
        if not U:
            return
        start, end = datetime.combine(a, datetime.min.time()), datetime.combine(b + timedelta(days=1), datetime.min.time())
        self._leads(U, start, end) if objs.get("leads", True) else None
        self._deals(U) if objs.get("opps", True) else None
        self._quotes(U, start, end) if objs.get("quotes", True) else None
        self._bids(U) if objs.get("tenders", True) else None
        self._orders(U) if objs.get("wo", True) else None
        self._pays(U)

    def _safe(self, name: str, fn) -> None:
        try:
            fn()
        except Exception as exc:
            self.db.rollback()
            logger.warning("commitments: %s achievements unavailable: %s", name, exc)

    def _leads(self, U, start, end):
        def run():
            q = self.db.query(Lead.id, Lead.assigned_to, Lead.created_by, Lead.est_value, Lead.lead_created_at, Lead.created_at).filter(
                Lead.is_deleted == False, Lead.lead_ref_id.isnot(None),  # noqa: E712
                or_(and_(Lead.lead_created_at >= start, Lead.lead_created_at < end),
                    and_(Lead.lead_created_at.is_(None), Lead.created_at >= start, Lead.created_at < end)),
                or_(Lead.assigned_to.in_(U), Lead.created_by.in_(U)))
            for r in q.all():
                o = r.assigned_to or r.created_by
                if o and int(o) in U:
                    self.ev["lead"].append(Ev(_day(r.lead_created_at or r.created_at), {int(o)}, f(r.est_value)))
        self._safe("lead", run)

    def _deals(self, U):
        def run():
            from app.services import deal_service as DS
            DS.ensure_schema(self.db)
            leads = self.db.query(Lead).filter(Lead.is_deleted == False, DS.deal_clause(), Lead.assigned_to.in_(U)).all()  # noqa: E712
            if not leads:
                return
            profiles, st = DS.sync(self.db, leads, DS.pipelines(self.db))
            for l in leads:
                s = st.get(l.id)
                if not s or s["stage"]["kind"] != "won":
                    continue
                prof = profiles.get(l.id)
                won_on = _day(l.converted_at) or _day(prof.stage_entered_at if prof else None) or (prof.close_date if prof else None) or _day(l.updated_at)
                if won_on:
                    self.ev["deal"].append(Ev(won_on, {int(l.assigned_to)}, f(l.est_value), ref={"id": l.id}))
        self._safe("deal", run)

    def _quotes(self, U, start, end):
        def run():
            from app.services import quote_service as QS
            nums = {n for (n,) in self.db.query(Quotation.quotation_number).filter(
                or_(Quotation.created_by.in_(U), Quotation.signatory_user_id.in_(U)), Quotation.created_at < end).distinct().all()}
            for rows in QS.groups(self.db, nums).values():
                latest = rows[-1]
                if (latest.status or "Draft") == "Draft":
                    continue
                o, d = QS.owner_of(latest), _day(latest.created_at)
                if o and int(o) in U and d and start.date() <= d < end.date():
                    self.ev["quote"].append(Ev(d, {int(o)}, f(latest.total_amount)))
        self._safe("quote", run)

    def _bids(self, U):
        def run():
            T = self.db.query(Tender).filter(Tender.is_deleted == False, Tender.submission_date >= self.a,  # noqa: E712
                                             Tender.submission_date <= self.b).all()
            if not T:
                return
            kams = _customer_kams(self.db, [t.customer_id for t in T])
            sub = _bid_submitted(self.db, T)
            for t in T:
                own = {int(x) for x in (t.assigned_to, kams.get(t.customer_id or 0)) if x}
                if own & U and sub.get(t.id):
                    self.ev["bid"].append(Ev(_day(t.submission_date), own, f(t.est_value), ref={"id": t.id}))
        self._safe("bid", run)

    def _orders(self, U):
        def run():
            s0 = datetime.combine(self.a, datetime.min.time())
            e0 = datetime.combine(self.b + timedelta(days=1), datetime.min.time())
            W = self.db.query(WorkOrder.id, WorkOrder.customer_id, WorkOrder.project_manager_id, WorkOrder.created_by, WorkOrder.wo_value,
                              WorkOrder.po_value, WorkOrder.po_date, WorkOrder.created_at).filter(
                WorkOrder.status.notin_(("Draft", "Cancelled", "Lost")),
                or_(and_(WorkOrder.po_date >= self.a, WorkOrder.po_date <= self.b),
                    and_(WorkOrder.po_date.is_(None), WorkOrder.created_at >= s0, WorkOrder.created_at < e0))).all()
            kams = _customer_kams(self.db, [w.customer_id for w in W])
            for w in W:
                own = {int(x) for x in (kams.get(w.customer_id or 0), w.project_manager_id) if x} or ({int(w.created_by)} if w.created_by else set())
                if own & U:
                    self.ev["order"].append(Ev(_day(w.po_date or w.created_at), own, f(w.wo_value) or f(w.po_value), ref={"id": w.id}))
        self._safe("order", run)

    def _pays(self, U):
        def run():
            self.receipts = self.db.query(OrderPaymentReceipt).filter(OrderPaymentReceipt.received_on >= self.a,
                                                                       OrderPaymentReceipt.received_on <= self.b,
                                                                       OrderPaymentReceipt.status.in_(("Acknowledged", "Pending finance"))).all()
            for r in self.receipts:
                if r.recorded_by and int(r.recorded_by) in U:
                    self.ev["pay"].append(Ev(r.received_on, {int(r.recorded_by)}, f(r.amount), pend=r.status != "Acknowledged"))
        self._safe("pay", run)

    def act(self, W: Iterable[int], t: str, a: date, b: date) -> dict[str, float]:
        """prototype cmAct: count / value achieved by W in [a, b] (up to today); pending Finance shown separately."""
        Ws = set(W)
        n = v = pend = 0.0
        for e in self.ev.get(t, []):
            if not (e.own & Ws) or e.d < a or e.d > b:
                continue
            if e.pend:
                pend += e.v
            elif e.d <= self.today:
                n += 1
                v += e.v
        return {"n": n, "v": v, "pend": pend}


# ─── commitments in a window ──────────────────────────────────────────────────

def overlap_days(c_from: date, c_to: date, a: date, b: date) -> int:
    s, e = max(c_from, a), min(c_to, b)
    return 0 if s > e else (e - s).days + 1


def share(c: Commitment, a: date, b: date) -> float:
    return overlap_days(c.period_from, c.period_to, a, b) / ((c.period_to - c.period_from).days + 1)


def csum(lines: list[CommitmentEntry], t: str) -> dict[str, float]:
    L = [l for l in lines if l.type == t]
    return {"n": sum(f(l.n) for l in L), "v": sum(f(l.value) for l in L)}


def eff_status(c: Commitment, today: Optional[date] = None) -> str:
    return "Closed" if c.period_to < (today or today_ist()) else c.status


class Ctx:
    """Everything one screen needs for the window [a, b]: people, settings, types, commitments and achievements."""

    def __init__(self, db: Session, cu: User, a: date, b: date, *, cfg: Optional[dict] = None, people: Optional[People] = None,
                 sources: bool = True):
        self.db, self.cu, self.a, self.b, self.today = db, cu, a, b, today_ist()
        self.cfg = cfg or settings(db)
        self.objs = flow_objects(db)
        self.types = types_on(self.cfg, self.objs)
        self.P = people or People(db, cu, self.cfg)
        self.m0 = fy_start_month(db)
        owners = self.P.owners()
        self.cmts: list[Commitment] = db.query(Commitment).filter(Commitment.owner_id.in_(list(owners) or [-1]), Commitment.period_from <= b,
                                                                  Commitment.period_to >= a).all()
        ids = [c.id for c in self.cmts]
        self.lines: dict[int, list[CommitmentEntry]] = defaultdict(list)
        if ids:
            for e in db.query(CommitmentEntry).filter(CommitmentEntry.commitment_id.in_(ids)).order_by(CommitmentEntry.sort, CommitmentEntry.id).all():
                self.lines[e.commitment_id].append(e)
        self.by_owner: dict[tuple[int, str], list[Commitment]] = defaultdict(list)
        for c in self.cmts:
            self.by_owner[(int(c.owner_id), c.scope or "self")].append(c)
        self.S = Sources(db, owners, a, b, self.objs) if sources else None
        self._wo: Optional[list] = None
        self._ten: dict[int, bool] = {}
        self._deal: dict[int, Optional[date]] = {}

    # prototype cmFor
    def cm_for(self, uid: int, t: str, a: date, b: date, scope: str = "self") -> Optional[dict[str, Any]]:
        L = [c for c in self.by_owner.get((uid, scope), []) if c.period_from <= b and c.period_to >= a and any(l.type == t for l in self.lines[c.id])]
        if not L:
            return None
        m = min(PRANK[c.period_type] for c in L)
        U = [c for c in L if PRANK[c.period_type] == m]
        x = {"n": 0.0, "v": 0.0, "per": U[0].period_type, "ids": [c.id for c in U]}
        for c in U:
            sh, s = share(c, a, b), csum(self.lines[c.id], t)
            x["n"] += s["n"] * sh
            x["v"] += s["v"] * sh
        return x

    def rows(self, a: date, b: date) -> list[dict[str, Any]]:
        """prototype cmRows – one row per person: committed vs achieved per type, submitted?, score."""
        out = []
        for p in self.P.list:
            mg = p["head"]
            W = self.P.W(p["id"])
            ty, sc = {}, []
            for t in self.types:
                cm = self.cm_for(p["id"], t["k"], a, b, "team" if mg else "self")
                ac = self.S.act(W, t["k"], a, b) if self.S else {"n": 0, "v": 0, "pend": 0}
                key = "v" if t.get("money") else "n"
                cv = cm[key] if cm else 0.0
                av = ac[key]
                pp = round(av / cv * 100) if cm and cv > 0 else None
                ty[t["k"]] = {"cm": bool(cm), "per": cm["per"] if cm else None, "cv": round(cv, 2), "av": round(av, 2),
                              "cvv": round(cm["v"], 2) if cm else 0.0, "avv": round(ac["v"], 2), "pend": round(ac["pend"], 2), "p": pp}
                if pp is not None:
                    sc.append(min(pp, SCORE_CAP))
            team = self.P.team(p["id"])
            out.append({"id": p["id"], "n": p["name"], "team": team, "tk": team, "mgr": mg, "ty": ty,
                        "sub": any(x["cm"] for x in ty.values()), "score": round(sum(sc) / len(sc)) if sc else None})
        return out

    # prototype cmLine – one entry's own achievement (payments, a named deal or tender)
    def _orders_index(self) -> list:
        if self._wo is None:
            self._wo = self.db.query(WorkOrder.id, WorkOrder.customer_id, WorkOrder.tender_id).all()
        return self._wo

    def _tender_ok(self, tid: int) -> bool:
        if tid not in self._ten:
            t = self.db.query(Tender).filter(Tender.id == tid).first()
            self._ten[tid] = bool(t and _bid_submitted(self.db, [t]).get(t.id))
        return self._ten[tid]

    def _deal_won(self, did: int) -> Optional[date]:
        if did not in self._deal:
            hit = next((e.d for e in (self.S.ev["deal"] if self.S else []) if e.ref and e.ref.get("id") == did), None)
            self._deal[did] = hit
        return self._deal[did]

    def line(self, l: CommitmentEntry, a: date, b: date) -> Optional[dict[str, Any]]:
        if l.type == "pay":
            hits = set()
            for w in self._orders_index():
                if l.work_order_id:
                    ok = w.id == l.work_order_id
                elif l.tender_id:
                    ok = w.tender_id == l.tender_id
                else:
                    ok = l.customer_id is not None and w.customer_id == l.customer_id and (not l.old_tender or not w.tender_id)
                if ok:
                    hits.add(w.id)
            ack = pen = 0.0
            for r in (self.S.receipts if self.S else []):
                if r.wo_id in hits and a <= r.received_on <= b:
                    if r.status == "Acknowledged":
                        ack += f(r.amount)
                    elif r.status == "Pending finance":
                        pen += f(r.amount)
            p = round(ack / f(l.value) * 100) if f(l.value) else 0
            return {"ack": ack, "pen": pen, "p": p, "st": cm_st(p, b, pen, self.today)}
        if l.type == "deal" and l.deal_id:
            w = self._deal_won(l.deal_id)
            ok = bool(w and a <= w <= b)
            return {"p": 100 if ok else 0, "st": cm_st(100 if ok else 0, b, 0, self.today)}
        if l.type == "bid" and l.tender_id:
            ok = self._tender_ok(l.tender_id)
            return {"p": 100 if ok else 0, "st": cm_st(100 if ok else 0, b, 0, self.today)}
        return None

    def pay_lines(self, a: date, b: date) -> list[dict[str, Any]]:
        """prototype cmPayLines – payment entries of the commitments covering [a, b]."""
        out = []
        for c in self.cmts:
            if not (c.period_from <= b and c.period_to >= a):
                continue
            for l in self.lines[c.id]:
                if l.type != "pay" or not (c.period_type == "Week" or not l.expected_on or a <= l.expected_on <= b):
                    continue
                wk = c.period_type == "Week"
                r = self.line(l, c.period_from if wk else a, c.period_to if wk else b)
                out.append({"id": f"{c.id}-{l.id}", "cid": c.id, "owner_id": c.owner_id, "owner": self.P.all_names.get(c.owner_id) or "",
                            "per": c.period_type, "share": round(share(c, a, b), 4), "customer": l.customer_name or "", "customer_id": l.customer_id,
                            "tender_id": l.tender_id, "tender": None, "old_tender": l.old_tender or "", "wo_id": l.work_order_id,
                            "v": f(l.value), "due": iso(l.expected_on), **{k: r[k] for k in ("ack", "pen", "st")}})
        _tender_refs(self.db, out)
        return sorted(out, key=lambda x: -x["v"])


def _tender_refs(db: Session, rows: list[dict[str, Any]], key: str = "tender_id") -> None:
    ids = {r[key] for r in rows if r.get(key)}
    if not ids:
        return
    ref = {t.id: (t.tender_num or f"TND-{t.id}") for t in db.query(Tender.id, Tender.tender_num).filter(Tender.id.in_(ids)).all()}
    for r in rows:
        if r.get(key):
            r["tender"] = ref.get(r[key], f"TND-{r[key]}")


def cm_st(p: float, b: date, pen: float, today: date) -> str:
    return "Achieved" if p >= 100 else "Partly achieved" if p > 0 else "Awaiting finance" if pen else "Open" if b >= today else "Missed"


def agg(rows: list[dict[str, Any]], types: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """prototype cmAgg – team totals from the individual rows (manager / team commitments are never added in)."""
    m: dict[str, dict[str, Any]] = {}
    for r in rows:
        if r["mgr"]:
            continue
        g = m.setdefault(r["tk"], {"tk": r["tk"], "n": 0, "sub": 0, "ty": {}})
        g["n"] += 1
        g["sub"] += 1 if r["sub"] else 0
        for t in types:
            x = r["ty"].get(t["k"])
            if not x:
                continue
            y = g["ty"].setdefault(t["k"], {"cv": 0.0, "av": 0.0, "cvv": 0.0, "avv": 0.0, "pend": 0.0})
            for k in y:
                y[k] += x[k]
    out = []
    for g in m.values():
        sc = []
        for t in types:
            y = g["ty"].get(t["k"])
            if not y:
                continue
            y["cm"] = y["cv"] > 0
            y["p"] = round(y["av"] / y["cv"] * 100) if y["cv"] > 0 else None
            if y["p"] is not None:
                sc.append(min(y["p"], SCORE_CAP))
        g["score"] = round(sum(sc) / len(sc)) if sc else None
        out.append(g)
    return out


def tot(rows: list[dict[str, Any]], types: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """prototype cmTot – company totals per type over the individual rows (manager rows excluded)."""
    o = {}
    for t in types:
        L = [r["ty"][t["k"]] for r in rows if not r["mgr"] and t["k"] in r["ty"]]
        cv, av = sum(x["cv"] for x in L), sum(x["av"] for x in L)
        o[t["k"]] = {"cv": cv, "av": av, "cvv": sum(x["cvv"] for x in L), "avv": sum(x["avv"] for x in L), "pend": sum(x["pend"] for x in L),
                     "p": round(av / cv * 100) if cv > 0 else None, "n": sum(1 for x in L if x["cm"])}
    return o


def overall(rows: list[dict[str, Any]]) -> int:
    s = [min(r["score"], SCORE_CAP) for r in rows if not r["mgr"] and r["score"] is not None]
    return round(sum(s) / len(s)) if s else 0


# ─── payloads ─────────────────────────────────────────────────────────────────

def _week_param(week: Optional[str]) -> date:
    cur = wk_start(today_ist())
    if not week:
        return cur
    w = wk_start(parse_day(week, "week"))
    return min(w, cur + timedelta(days=7))           # up to next week, like the prototype week bar


def meta(db: Session, cu: User) -> dict[str, Any]:
    cfg = settings(db)
    objs = flow_objects(db)
    P = People(db, cu, cfg)
    on = {t["k"] for t in types_on(cfg, objs)}
    can_sub = user_has_permission(db, cu, "kam.create")
    manage = user_has_permission(db, cu, "kam.update")
    tg = annual_targets(db, P.owners())
    people = [{"id": p["id"], "name": p["name"], "cat": p["cat"], "head": p["head"], "team": P.team(p["id"]), "team_id": P.team_id(p["id"]),
               "target": tg.get(p["id"], 0.0) if not p["head"] else sum(tg.get(m, 0.0) for m in P.members(p["id"])),
               "members": [P.all_names.get(m, "") for m in P.members(p["id"])] if p["head"] else []} for p in P.list]
    from app.utils.data_scope import get_module_data_scope
    vis = db.query(User.role).filter(User.id.in_(scope_uids(db, cu) or [-1]), User.is_active == True).all()  # noqa: E712
    cats: dict[str, int] = defaultdict(int)
    for (r,) in vis:
        cats[role_cat(r) or "other"] += 1
    diag = {"scope": get_module_data_scope(db, cu, "kam"), "visible": len(vis), "by_role": dict(cats), "roles": cfg["roles"], "my_role": cu.role}
    if not people:
        logger.info("commitments: no commitment givers for user %s – %s", cu.id, diag)
    return {"me": {"id": cu.id, "name": cu.full_name}, "today": iso(today_ist()), "diag": diag, "week": iso(wk_start(today_ist())), "fy_start_month": fy_start_month(db),
            "types": [{**t, "flow": not t["mod"] or objs[t["mod"]], "on": t["k"] in on,
                       "mod_label": MOD_LABEL.get(t["mod"], "")} for t in CMT_ALL],
            "settings": cfg, "cutoffs": list(CUTOFFS), "periods": list(PERIODS), "roles": list(ROLES), "flow": flow_label(objs),
            "people": people, "teams": [{"id": t["id"], "name": t["name"], "lead": P.all_names.get(t["lead_id"] or 0, "")} for t in P.teams],
            "can": {"submit": can_sub, "manage": manage, "settings": can_settings(db, cu), "export": user_has_permission(db, cu, "kam.export"),
                    "others": manage}}


def week_view(db: Session, cu: User, week: Optional[str], team: Optional[str]) -> dict[str, Any]:
    a = _week_param(week)
    b = a + timedelta(days=6)
    C = Ctx(db, cu, a, b)
    allr = C.rows(a, b)
    rows = allr if not team or team == "All" else [r for r in allr if r["tk"] == team or r["mgr"]]
    names = {r["id"] for r in rows}
    PL = [x for x in C.pay_lines(a, b) if not team or team == "All" or x["owner_id"] in names]
    _auto_cutoff_reminders(db, C, allr, a)
    return {"week": week_json(a), "types": C.types, "rows": rows, "tot": tot(rows, C.types), "agg": agg(rows, C.types),
            "teams": list(dict.fromkeys(r["tk"] for r in allr if not r["mgr"])), "pay": PL,
            "pay_total": round(sum(x["v"] if x["per"] == "Week" else x["v"] * x["share"] for x in PL), 2),
            "missing": [{"id": r["id"], "n": r["n"], "tk": r["tk"]} for r in rows if not r["mgr"] and not r["sub"]],
            "cutoff": C.cfg["cutoff"]}


def week_json(a: date) -> dict[str, Any]:
    t = today_ist()
    cur = wk_start(t)
    n = (cur - a).days // 7
    return {"from": iso(a), "to": iso(a + timedelta(days=6)), "label": per_of("Week", a)["label"], "no": wk_no(a), "offset": n,
            "day": (t - a).days + 1 if n == 0 else None, "pace": round(((t - cur).days + 1) / 7 * 100) if n == 0 else None,
            "can_next": a < cur + timedelta(days=7), "current": iso(cur)}


def dashboard(db: Session, cu: User, week: Optional[str]) -> dict[str, Any]:
    a = _week_param(week)
    b = a + timedelta(days=6)
    wk = weeks_back(8)
    lo, hi = min(wk[0], a), max(wk[-1] + timedelta(days=6), a + timedelta(days=13))
    C = Ctx(db, cu, lo, hi)
    rows = C.rows(a, b)
    self_ = [r for r in rows if not r["mgr"]]
    R_ = [C.rows(w, w + timedelta(days=6)) for w in wk]
    hist = []
    for w, rs in zip(wk, R_):
        T = tot(rs, C.types)
        hist.append({"w": f"W{wk_no(w)}", "from": iso(w), "pay_cv": T["pay"]["cv"] if "pay" in T else 0, "pay_av": T["pay"]["av"] if "pay" in T else 0,
                     "score": overall(rs)})
    heat = []
    for r in self_:
        cells = []
        for rs in R_:
            x = next((y for y in rs if y["id"] == r["id"] and not y["mgr"]), None)
            cells.append(x["score"] if x and x["score"] is not None else None)
        heat.append({"id": r["id"], "n": r["n"], "v": cells})
    nx = [r for r in C.rows(a + timedelta(days=7), a + timedelta(days=13)) if not r["mgr"]]
    return {"week": week_json(a), "types": C.types, "rows": rows, "tot": tot(rows, C.types), "agg": agg(rows, C.types), "hist": hist, "heat": heat,
            "pay": C.pay_lines(a, b)[:8], "risk": [{"id": r["id"], "n": r["n"], "tk": r["tk"], "score": r["score"]}
                                                    for r in sorted(self_, key=lambda r: r["score"] or 0) if r["score"] is not None and r["score"] < 50],
            "submission": {"cur": {"no": wk_no(a), "sub": sum(1 for r in self_ if r["sub"]), "total": len(self_)},
                           "next": {"no": wk_no(a + timedelta(days=7)), "from": iso(a + timedelta(days=7)), "sub": sum(1 for r in nx if r["sub"]), "total": len(nx),
                                    "missing": [{"id": r["id"], "n": r["n"]} for r in nx if not r["sub"]]}}}


def person(db: Session, cu: User, uid: int, week: Optional[str]) -> dict[str, Any]:
    a = _week_param(week)
    b = a + timedelta(days=6)
    wk = weeks_back(8)
    C = Ctx(db, cu, min(wk[0], a), max(wk[-1] + timedelta(days=6), b))
    if uid not in C.P.by_id:
        raise HTTPException(403, "You are not authorised to view this employee's commitments")
    r = next((x for x in C.rows(a, b) if x["id"] == uid), None)
    hist = []
    for w in wk:
        x = next((y for y in C.rows(w, w + timedelta(days=6)) if y["id"] == uid), None)
        hist.append({"w": f"W{wk_no(w)}", "score": x["score"] if x else None, "pay_cv": x["ty"]["pay"]["cv"] if x and "pay" in x["ty"] else 0,
                     "pay_av": x["ty"]["pay"]["av"] if x and "pay" in x["ty"] else 0})
    p = C.P.by_id[uid]
    tg = annual_targets(db, C.P.W(uid) if p["head"] else [uid])
    allc = db.query(Commitment).filter(Commitment.owner_id == uid).order_by(Commitment.period_from.desc(), Commitment.id.desc()).all()
    return {"week": week_json(a), "types": C.types, "person": {"id": uid, "name": p["name"], "team": C.P.team(uid), "head": p["head"],
                                                               "target": sum(tg.values())},
            "row": r, "hist": hist, "commitments": [c_summary(db, c, C.types, cover=(c.period_from <= b and c.period_to >= a)) for c in allc]}


def report(db: Session, cu: User, n: int) -> dict[str, Any]:
    n = n if n in (4, 8, 13) else 8
    wk = weeks_back(n)
    C = Ctx(db, cu, wk[0], wk[-1] + timedelta(days=6))
    weeks = []
    for w in wk:
        rs = C.rows(w, w + timedelta(days=6))
        weeks.append({"w": f"W{wk_no(w)}", "from": iso(w), "label": per_of("Week", w)["label"], "short": fd_s(w), "rows": rs, "agg": agg(rs, C.types),
                      "tot": tot(rs, C.types), "overall": overall(rs)})
    return {"types": C.types, "weeks": weeks}


def _lines_by(db: Session, ids: list[int]) -> dict[int, list[CommitmentEntry]]:
    out: dict[int, list[CommitmentEntry]] = defaultdict(list)
    if ids:
        for e in db.query(CommitmentEntry).filter(CommitmentEntry.commitment_id.in_(ids)).order_by(CommitmentEntry.sort, CommitmentEntry.id).all():
            out[e.commitment_id].append(e)
    return out


def c_summary(db: Session, c: Commitment, types: list[dict[str, Any]], lines: Optional[list[CommitmentEntry]] = None, names: Optional[dict] = None,
              cover: bool = False) -> dict[str, Any]:
    L = lines if lines is not None else _lines_by(db, [c.id])[c.id]
    ent = []
    for t in types:
        if any(l.type == t["k"] for l in L):
            s = csum(L, t["k"])
            ent.append({"k": t["k"], "n": s["n"], "v": s["v"]})
    nm = names or {}
    return {"id": c.id, "code": c.code or f"CMT-{c.id:04d}", "owner_id": c.owner_id, "owner": nm.get(c.owner_id, ""), "team": c.team_name or "Unassigned",
            "scope": c.scope, "per": c.period_type, "from": iso(c.period_from), "to": iso(c.period_to), "label": c.label, "entries": ent,
            "n_entries": len(L), "pay": csum(L, "pay")["v"], "target": f(c.target), "submitted": iso(c.submitted_at), "status": eff_status(c),
            "cover": cover}


def register(db: Session, cu: User) -> dict[str, Any]:
    cfg = settings(db)
    P = People(db, cu, cfg)
    T = types_on(cfg, flow_objects(db))
    uids = set(scope_uids(db, cu))
    C_ = db.query(Commitment).filter(Commitment.owner_id.in_(list(uids) or [-1])).order_by(Commitment.period_from.desc(), Commitment.submitted_at.desc()).all()
    L = _lines_by(db, [c.id for c in C_])
    nm = {**P.all_names, **{u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_({c.owner_id for c in C_} or {-1})).all()}}
    return {"types": T, "rows": [c_summary(db, c, T, L[c.id], nm) for c in C_]}


def _visible(db: Session, cu: User, c: Commitment) -> None:
    if int(c.owner_id) not in set(scope_uids(db, cu)):
        raise HTTPException(404, "Commitment not found")


def get_c(db: Session, cu: User, cid: int) -> Commitment:
    c = db.query(Commitment).filter(Commitment.id == cid).first()
    if not c:
        raise HTTPException(404, "Commitment not found")
    _visible(db, cu, c)
    return c


def detail(db: Session, cu: User, cid: int) -> dict[str, Any]:
    c = get_c(db, cu, cid)
    cfg = settings(db)
    P = People(db, cu, cfg)
    C = Ctx(db, cu, c.period_from, c.period_to, cfg=cfg, people=P)
    L = _lines_by(db, [c.id])[c.id]
    W = P.members(c.owner_id) if c.scope == "team" and c.owner_id in P.by_id and P.by_id[c.owner_id]["head"] else [c.owner_id]
    if c.scope == "team" and not W:
        W = [m for t in P.teams for m in t["members"]]
    days = (c.period_to - c.period_from).days + 1
    el = max(0, min((C.today - c.period_from).days + 1, days))
    per = []
    for t in C.types:
        TL = [l for l in L if l.type == t["k"]]
        if not TL:
            continue
        s, ac = csum(L, t["k"]), C.S.act(W, t["k"], c.period_from, c.period_to)
        cv, av = (s["v"], ac["v"]) if t.get("money") else (s["n"], ac["n"])
        entries = []
        for l in TL:
            r = C.line(l, c.period_from, c.period_to)
            entries.append({"id": l.id, "n": f(l.n), "v": f(l.value), "customer": l.customer_name or "", "customer_id": l.customer_id, "tender_id": l.tender_id,
                            "tender": None, "old_tender": l.old_tender or "", "wo_id": l.work_order_id, "deal_id": l.deal_id, "source": l.source or "",
                            "due": iso(l.expected_on), "note": l.note or "", "r": r})
        _tender_refs(db, entries)
        per.append({"k": t["k"], "cv": cv, "av": av, "p": round(av / cv * 100) if cv else 0, "exp": round(el / days * 100), "pend": ac["pend"], "entries": entries})
    wks = []
    w = wk_start(c.period_from)
    while w <= c.period_to:
        b = w + timedelta(days=6)
        cells = []
        for x in per:
            t = next(t for t in C.types if t["k"] == x["k"])
            s = csum(L, x["k"])
            cv = (s["v"] if t.get("money") else s["n"]) * share(c, w, b)
            ac = C.S.act(W, x["k"], max(w, c.period_from), min(b, c.period_to))
            av = ac["v"] if t.get("money") else ac["n"]
            cells.append({"k": x["k"], "cv": round(cv, 2), "av": av, "p": round(av / cv * 100) if cv else 0, "future": w > C.today})
        wks.append({"from": iso(w), "label": per_of("Week", w)["label"], "cells": cells})
        w += timedelta(days=7)
    nm = {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_({x for x in (c.owner_id, c.submitted_by, c.acknowledged_by, c.edited_by) if x})).all()}
    st = eff_status(c)
    manage = _may_act_for(db, cu, c.owner_id)
    return {"id": c.id, "code": c.code or f"CMT-{c.id:04d}", "owner_id": c.owner_id, "owner": nm.get(c.owner_id, ""), "label": c.label, "per": c.period_type,
            "scope": c.scope, "team": c.team_name or "Unassigned", "status": st, "from": iso(c.period_from), "to": iso(c.period_to), "days": days,
            "elapsed": el, "closed": c.period_to < C.today, "target": f(c.target), "pay": csum(L, "pay")["v"],
            "submitted_at": c.submitted_at.isoformat() if c.submitted_at else None, "submitted_by": nm.get(c.submitted_by or 0, ""),
            "acknowledged_by": nm.get(c.acknowledged_by or 0, ""), "acknowledged_at": c.acknowledged_at.isoformat() if c.acknowledged_at else None,
            "edited_at": c.edited_at.isoformat() if c.edited_at else None, "note": c.note or "", "types": C.types, "per_type": per,
            "weeks": wks if len(wks) > 1 else [],
            "can": {"edit": c.period_to >= C.today and (_is_owner_submit(db, cu, c.owner_id) or manage),
                    "ack": st == "Submitted" and manage and int(c.owner_id) != int(cu.id),
                    "delete": _may_delete(db, cu, c)},
            "edit": {"owner_id": c.owner_id, "per": c.period_type, "anchor": iso(c.period_from), "note": c.note or "",
                     "entries": [_entry_json(l) for l in L]}}


def _entry_json(l: CommitmentEntry) -> dict[str, Any]:
    return {"type": l.type, "n": f(l.n), "value": f(l.value), "customer_id": l.customer_id, "customer_name": l.customer_name or "", "tender_id": l.tender_id,
            "old_tender": l.old_tender or "", "work_order_id": l.work_order_id, "deal_id": l.deal_id, "source": l.source or "",
            "expected_on": iso(l.expected_on), "note": l.note or ""}


# ─── form data ────────────────────────────────────────────────────────────────

def form_meta(db: Session, cu: User, owner_id: int) -> dict[str, Any]:
    cfg = settings(db)
    P = People(db, cu, cfg)
    if owner_id not in P.by_id:
        raise HTTPException(403, "You can't enter a commitment for this employee")
    p = P.by_id[owner_id]
    customers: list[dict[str, Any]] = []
    if user_has_permission(db, cu, "customers.view"):
        from app.routers.customer_router import _apply_customer_data_scope
        q = _apply_customer_data_scope(db, db.query(Customer.id, Customer.customer_name), cu).filter(Customer.is_deleted == False)  # noqa: E712
        customers = [{"id": c.id, "name": c.customer_name} for c in q.order_by(Customer.customer_name).all()]
    deals: list[dict[str, Any]] = []
    try:
        from app.services import deal_service as DS
        DS.ensure_schema(db)
        L = db.query(Lead).filter(Lead.is_deleted == False, DS.deal_clause(), Lead.assigned_to == owner_id).all()  # noqa: E712
        _, st = DS.sync(db, L, DS.pipelines(db))
        deals = [{"id": l.id, "name": l.lead_title or "", "value": f(l.est_value), "customer_id": l.customer_id, "customer": l.customer_name or "",
                  "close": None} for l in L if st.get(l.id) and st[l.id]["stage"]["kind"] == "open"]
    except Exception as exc:
        db.rollback()
        logger.warning("commitments form: deals unavailable: %s", exc)
    tenders: list[dict[str, Any]] = []
    try:
        T = db.query(Tender).filter(Tender.is_deleted == False, or_(Tender.result.is_(None), Tender.result == "")).all()  # noqa: E712
        kams = _customer_kams(db, [t.customer_id for t in T])
        mine = [t for t in T if t.assigned_to == owner_id or kams.get(t.customer_id or 0) == owner_id]
        sub = _bid_submitted(db, mine)
        tenders = [{"id": t.id, "ref": t.tender_num or f"TND-{t.id}", "customer": t.customer_name or "", "value": f(t.est_value), "submit": iso(t.submission_date)}
                   for t in mine if not sub.get(t.id)]
    except Exception as exc:
        db.rollback()
        logger.warning("commitments form: tenders unavailable: %s", exc)
    sources = [s.name for s in db.query(LeadSource.name).filter(LeadSource.is_active != False).order_by(LeadSource.name).all()]  # noqa: E712
    existing = [{"id": c.id, "code": c.code or f"CMT-{c.id:04d}", "per": c.period_type, "from": iso(c.period_from), "scope": c.scope}
                for c in db.query(Commitment).filter(Commitment.owner_id == owner_id).all()]
    W = P.members(owner_id) if p["head"] else [owner_id]
    tg = annual_targets(db, W)
    m0 = fy_start_month(db)
    return {"owner": {"id": owner_id, "name": p["name"], "head": p["head"], "team": P.team(owner_id),
                      "teams": [t["name"] for t in P.teams if (t["lead_id"] == owner_id) or (p["head"] and not any(x["lead_id"] == owner_id for x in P.teams))]},
            "target": sum(tg.values()), "customers": customers, "deals": deals, "tenders": tenders, "sources": sources, "existing": existing,
            "periods": {per: per_options(per, m0) for per in cfg["periods"]}, "m0": m0}


def period_info(db: Session, per: str, anchor: str) -> dict[str, Any]:
    if per not in PERIODS:
        raise HTTPException(422, "Unknown period type")
    m0 = fy_start_month(db)
    a = parse_day(anchor, "period")
    return {**per_json(per_of(per, a, m0)), "options": per_options(per, m0, a)}


def customer_refs(db: Session, cu: User, customer_id: int) -> dict[str, Any]:
    """Tenders and orders of a customer for a payment entry, with the next unpaid payment stage of each order."""
    from app.routers.customer_router import _apply_customer_data_scope
    if not user_has_permission(db, cu, "customers.view"):
        raise HTTPException(403, "You don't have access to customers")
    if not _apply_customer_data_scope(db, db.query(Customer.id), cu).filter(Customer.id == customer_id).first():
        raise HTTPException(404, "Customer not found")
    T = db.query(Tender).filter(Tender.customer_id == customer_id, Tender.is_deleted == False).order_by(Tender.id.desc()).all()  # noqa: E712
    W = db.query(WorkOrder).filter(WorkOrder.customer_id == customer_id, WorkOrder.status.notin_(("Cancelled", "Lost"))).all()
    bal = _schedule_balance(db, [w.id for w in W])
    out: dict[int, dict[str, Any]] = {}
    for t in T:
        out[t.id] = {"tender_id": t.id, "label": f"{t.tender_num or f'TND-{t.id}'} · {(t.tender_title or '')[:34]} · {t.result or t.tender_status or ''}".strip(" ·"),
                     "wo_id": None, "value": f(t.est_value)}
    for w in W:
        if w.tender_id:
            o = out.setdefault(w.tender_id, {"tender_id": w.tender_id, "label": f"TND-{w.tender_id}", "value": 0.0})
            o["wo_id"] = w.id
            o["label"] = f"{o['label']} · order {w.wo_number}" if "order" not in o["label"] else o["label"]
            o["next"] = bal.get(w.id)
    return {"tenders": list(out.values()), "orders": [{"id": w.id, "number": w.wo_number, "tender_id": w.tender_id, "next": bal.get(w.id)} for w in W]}


def _schedule_balance(db: Session, wo_ids: list[int]) -> dict[int, dict[str, Any]]:
    """First payment stage of each order that still has a balance – the Orders & Projects payment schedule (v18)."""
    if not wo_ids:
        return {}
    from app.services.order_payment_service import next_balance
    return next_balance(db, db.query(WorkOrder).filter(WorkOrder.id.in_(wo_ids)).all())


# ─── permissions ──────────────────────────────────────────────────────────────

def _may_act_for(db: Session, cu: User, owner_id: int) -> bool:
    """Enter / edit / acknowledge someone else's commitment: kam.update and the person inside the caller's KAM scope."""
    from app.utils.data_scope import get_module_data_scope
    if not user_has_permission(db, cu, "kam.update"):
        return False
    if int(owner_id) not in set(scope_uids(db, cu)):
        return False
    return int(owner_id) != int(cu.id) or get_module_data_scope(db, cu, "kam") == "all"


def _is_owner_submit(db: Session, cu: User, owner_id: int) -> bool:
    return int(owner_id) == int(cu.id) and user_has_permission(db, cu, "kam.create")


def _may_delete(db: Session, cu: User, c: Commitment) -> bool:
    if _may_act_for(db, cu, c.owner_id) and (user_has_permission(db, cu, "kam.delete") or user_has_permission(db, cu, "kam.update")):
        return True
    return _is_owner_submit(db, cu, c.owner_id) and c.status == "Submitted" and c.period_to >= today_ist()


# ─── save / acknowledge / delete ──────────────────────────────────────────────

def _num(v: Any, what: str, lo: float = 0, hi: float = 1e13) -> Decimal:
    try:
        d = Decimal(str(v if v not in (None, "") else 0))
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(422, f"Enter a number for {what}")
    if not d.is_finite() or d < Decimal(str(lo)) or d > Decimal(str(hi)):
        raise HTTPException(422, f"{what[0].upper() + what[1:]} is out of range")
    return d


def _clean_entries(db: Session, cu: User, cfg: dict[str, Any], types: list[dict], body: dict[str, Any], owner_id: int) -> list[dict[str, Any]]:
    ok = {t["k"] for t in types}
    out = []
    for i, e in enumerate(body.get("entries") or []):
        t = e.get("type")
        if t not in ok:
            continue
        n, v = _num(e.get("n"), "the count", 0, 1e9), _num(e.get("value"), "the value")
        if t == "pay":
            if not e.get("customer_id") and not e.get("value"):
                continue
            n = Decimal(1)
        elif n <= 0 and v <= 0:
            continue                                           # an empty row is left out (prototype)
        x = {"type": t, "sort": i, "n": n, "value": v, "customer_id": None, "customer_name": None, "tender_id": None, "old_tender": None,
             "work_order_id": None, "deal_id": None, "source": (str(e.get("source") or "").strip()[:120] or None),
             "expected_on": parse_day(e["expected_on"], "expected date") if e.get("expected_on") else None,
             "note": (str(e.get("note") or "").strip()[:500] or None)}
        cid = e.get("customer_id")
        if cid:
            c = db.query(Customer.id, Customer.customer_name).filter(Customer.id == int(cid), Customer.is_deleted == False).first()  # noqa: E712
            if not c:
                raise HTTPException(422, "The customer on an entry no longer exists")
            x["customer_id"], x["customer_name"] = c.id, c.customer_name
        if t == "pay":
            if not x["customer_id"]:
                raise HTTPException(422, "Choose the customer for each payment")
            old = str(e.get("old_tender") or "").strip()[:300]
            if e.get("tender_id"):
                td = db.query(Tender.id, Tender.customer_id).filter(Tender.id == int(e["tender_id"]), Tender.is_deleted == False).first()  # noqa: E712
                if not td:
                    raise HTTPException(422, f"The tender for the payment from {x['customer_name']} no longer exists")
                x["tender_id"] = td.id
                wo = db.query(WorkOrder.id).filter(WorkOrder.tender_id == td.id).order_by(WorkOrder.id).first()
                x["work_order_id"] = wo.id if wo else None
            elif old:
                x["old_tender"] = old
            elif cfg["pay_tender"]:
                raise HTTPException(422, f"Choose the tender (or name the old tender) for the payment from {x['customer_name']}")
            if e.get("work_order_id") and not x["work_order_id"]:
                w = db.query(WorkOrder.id, WorkOrder.customer_id).filter(WorkOrder.id == int(e["work_order_id"])).first()
                if w and w.customer_id == x["customer_id"]:
                    x["work_order_id"] = w.id
            if v <= 0:
                raise HTTPException(422, f"Enter the amount for the payment from {x['customer_name']}")
            if not x["expected_on"] and e.get("expected_on"):
                raise HTTPException(422, "Enter a valid expected date")
        else:
            if n <= 0:
                raise HTTPException(422, "Enter how many for each entry")
            if t == "deal" and e.get("deal_id"):
                d = db.query(Lead.id, Lead.assigned_to).filter(Lead.id == int(e["deal_id"]), Lead.is_deleted == False).first()  # noqa: E712
                if not d:
                    raise HTTPException(422, "The deal on an entry no longer exists")
                x["deal_id"], x["n"] = d.id, Decimal(1)
            if t == "bid" and e.get("tender_id"):
                td = db.query(Tender.id).filter(Tender.id == int(e["tender_id"]), Tender.is_deleted == False).first()  # noqa: E712
                if not td:
                    raise HTTPException(422, "The tender on an entry no longer exists")
                x["tender_id"], x["n"] = td.id, Decimal(1)
        out.append(x)
    if not out:
        raise HTTPException(422, "Add at least one entry")
    return out


def save(db: Session, cu: User, body: dict[str, Any], request: Optional[Request], cid: Optional[int] = None) -> dict[str, Any]:
    cfg = settings(db)
    P = People(db, cu, cfg)
    types = types_on(cfg, flow_objects(db))
    old = get_c(db, cu, cid) if cid else None
    owner_id = int(old.owner_id if old else body.get("owner_id") or cu.id)
    if owner_id not in P.by_id:
        raise HTTPException(403, "This employee does not give commitments (Settings → Who gives commitments) or is outside your team")
    if not (_is_owner_submit(db, cu, owner_id) or _may_act_for(db, cu, owner_id)):
        raise HTTPException(403, "You can't enter a commitment for this employee" if owner_id != cu.id else "You don't have permission to submit commitments")
    per = str(body.get("per") or "Week")
    if per not in cfg["periods"]:
        raise HTTPException(422, f"{per} commitments are not allowed (Settings → Periods allowed)")
    m0 = fy_start_month(db)
    Pd = per_of(per, parse_day(body.get("anchor"), "period"), m0)
    if Pd["to"] < today_ist() and not (old and old.period_from == Pd["from"] and old.period_type == per):
        raise HTTPException(422, "That period is over – choose the current or a coming period")
    if old and old.period_to < today_ist():
        raise HTTPException(422, "This commitment's period is over and it can no longer be edited")
    entries = _clean_entries(db, cu, cfg, types, body, owner_id)
    head = P.by_id[owner_id]["head"]
    scope = "team" if head else "self"
    W = P.members(owner_id) if head else [owner_id]
    annual = sum(annual_targets(db, W).values())
    target = (Decimal(str(annual)) * Decimal(Pd["days"]) / Decimal(365)).quantize(Decimal("0.01"))
    dup = db.query(Commitment).filter(Commitment.owner_id == owner_id, Commitment.scope == scope, Commitment.period_type == per,
                                      Commitment.period_from == Pd["from"], Commitment.id != (old.id if old else -1)).with_for_update().first()
    if dup and not body.get("replace"):
        raise HTTPException(409, {"message": f"{P.by_id[owner_id]['name']} already has a {per.lower()} commitment for this period ({dup.code})",
                                  "existing_id": dup.id})
    now = now_ist()
    before = None
    try:
        if dup:                                        # "Saving replaces it" – the existing record is updated, never duplicated
            if old:
                db.delete(old)
                db.flush()
            old = dup
        if old:
            before = {"per": old.period_type, "from": iso(old.period_from), "entries": [_entry_json(l) for l in _lines_by(db, [old.id])[old.id]]}
            c = old
            db.query(CommitmentEntry).filter(CommitmentEntry.commitment_id == c.id).delete(synchronize_session=False)
            c.edited_at, c.edited_by = now, cu.id
        else:
            c = Commitment(owner_id=owner_id, scope=scope, created_at=now)
            db.add(c)
        c.owner_role = P.by_id[owner_id]["cat"]
        c.team_id, c.team_name = P.team_id(owner_id), P.team(owner_id)
        c.period_type, c.period_from, c.period_to, c.label = per, Pd["from"], Pd["to"], Pd["label"]
        c.target, c.note = target, (str(body.get("note") or "").strip()[:4000] or None)
        c.status, c.acknowledged_by, c.acknowledged_at = "Submitted", None, None
        c.submitted_at, c.submitted_by = now, cu.id
        db.flush()
        if not c.code:
            c.code = f"CMT-{c.id:04d}"
        for x in entries:
            db.add(CommitmentEntry(commitment_id=c.id, **x))
        db.flush()
        _notify_submitted(db, cu, c, P, edited=before is not None)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A commitment for this person and period was just saved by someone else – reload and edit it")
    _audit(db, cu, request, "update" if before else "create", c.id, f"Commitment {c.code} {'updated' if before else 'submitted'} – "
           f"{P.by_id[owner_id]['name']} · {c.label}", before, {"per": per, "from": iso(c.period_from), "entries": len(entries)})
    return {"id": c.id, "code": c.code, "label": c.label, "updated": before is not None}


def acknowledge(db: Session, cu: User, cid: int, request: Optional[Request]) -> dict[str, Any]:
    c = get_c(db, cu, cid)
    if not _may_act_for(db, cu, c.owner_id) or int(c.owner_id) == int(cu.id):
        raise HTTPException(403, "Only the person's manager can acknowledge this commitment")
    if eff_status(c) != "Submitted":
        raise HTTPException(409, f"This commitment is {eff_status(c).lower()} – nothing to acknowledge")
    c.status, c.acknowledged_by, c.acknowledged_at = "Acknowledged", cu.id, now_ist()
    _notify(db, c.owner_id, "Commitment acknowledged", f"{cu.full_name} acknowledged your {c.period_type.lower()} commitment for {c.label} ({c.code})",
            c.id, "commitment_acknowledged")
    db.commit()
    _audit(db, cu, request, "update", c.id, f"Commitment {c.code} acknowledged", {"status": "Submitted"}, {"status": "Acknowledged"})
    return {"id": c.id, "status": "Acknowledged"}


def delete(db: Session, cu: User, cid: int, request: Optional[Request]) -> None:
    c = get_c(db, cu, cid)
    if not _may_delete(db, cu, c):
        raise HTTPException(403, "You can't delete this commitment")
    snap = {"code": c.code, "owner_id": c.owner_id, "per": c.period_type, "from": iso(c.period_from), "status": c.status}
    db.query(CommitmentEntry).filter(CommitmentEntry.commitment_id == c.id).delete(synchronize_session=False)
    db.delete(c)
    db.commit()
    _audit(db, cu, request, "delete", cid, f"Commitment {snap['code']} deleted", snap, None)


# ─── teams ────────────────────────────────────────────────────────────────────

def add_team(db: Session, cu: User, name: str, request: Optional[Request]) -> dict[str, Any]:
    if not can_settings(db, cu):
        raise HTTPException(403, "Only a Sales Head or administrator can manage teams")
    nm = (name or "").strip()[:120]
    if not nm:
        raise HTTPException(422, "Name the team")
    if db.query(CommitmentTeam.id).filter(func.lower(CommitmentTeam.name) == nm.lower()).first():
        raise HTTPException(409, f"A team called “{nm}” already exists")
    heads = [p["id"] for p in People(db, cu, settings(db)).list if p["head"]]
    lead = cu.id if role_cat(cu.role) == "Sales Head" else (heads[0] if len(heads) == 1 else None)
    t = CommitmentTeam(name=nm, lead_id=lead, sort_order=(db.query(func.max(CommitmentTeam.sort_order)).scalar() or 0) + 1, created_by=cu.id)
    db.add(t)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"A team called “{nm}” already exists")
    _audit(db, cu, request, "create", t.id, f"Commitment team “{nm}” added", None, {"name": nm})
    return {"id": t.id, "name": t.name}


def assign_team(db: Session, cu: User, uid: int, team_id: Optional[int], request: Optional[Request]) -> dict[str, Any]:
    """Moves future reporting only – submitted commitments keep the team they were submitted under."""
    if not can_settings(db, cu):
        raise HTTPException(403, "Only a Sales Head or administrator can manage teams")
    if int(uid) not in set(scope_uids(db, cu)):
        raise HTTPException(403, "This employee is outside your team")
    t = db.get(CommitmentTeam, team_id) if team_id else None
    if team_id and not t:
        raise HTTPException(404, "Team not found")
    row = db.get(CommitmentTeamMember, uid)
    before = row.team_id if row else None
    if t is None:
        if row:
            db.delete(row)
    elif row:
        row.team_id, row.updated_by = t.id, cu.id
    else:
        db.add(CommitmentTeamMember(user_id=uid, team_id=t.id, updated_by=cu.id))
    db.commit()
    _audit(db, cu, request, "update", uid, f"Commitment team for user {uid} set to {t.name if t else 'Unassigned'}", {"team_id": before}, {"team_id": t.id if t else None})
    return {"user_id": uid, "team": t.name if t else "Unassigned"}


# ─── notifications ────────────────────────────────────────────────────────────

def _notify(db: Session, uid: Optional[int], title: str, msg: str, rid: int, action: str, email: bool = False) -> bool:
    if not uid:
        return False
    from app.services.notification_service import upsert_notification
    n, _ = upsert_notification(db, int(uid), title, msg, module=MODULE, record_id=rid, action=action, action_url="/kam?tab=commitments",
                               send_email=email)
    return n is not None


def _notify_submitted(db: Session, cu: User, c: Commitment, P: People, edited: bool) -> None:
    """New / changed commitment → the owner's manager (reporting manager, else their team lead) to acknowledge."""
    owner = P.by_id.get(c.owner_id) or {}
    to = {owner.get("manager_id")}
    t = P.team_of.get(c.owner_id)
    if t and t.get("lead_id"):
        to.add(t["lead_id"])
    who = owner.get("name") or "A colleague"
    verb = "updated" if edited else "submitted"
    for u in {x for x in to if x and int(x) not in (int(cu.id), int(c.owner_id))}:
        _notify(db, u, "Commitment awaiting acknowledgement", f"{who} {verb} a {c.period_type.lower()} commitment for {c.label} ({c.code})",
                c.id, "commitment_submitted")
    if int(cu.id) != int(c.owner_id):
        _notify(db, c.owner_id, "Commitment entered for you", f"{cu.full_name} entered your {c.period_type.lower()} commitment for {c.label} ({c.code})",
                c.id, "commitment_entered")


def week_key(a: date) -> int:
    return int(a.strftime("%Y%m%d"))


def remind(db: Session, cu: User, uids: list[int], week: Optional[str]) -> dict[str, Any]:
    if not user_has_permission(db, cu, "kam.update"):
        raise HTTPException(403, "You don't have permission to send reminders")
    a = _week_param(week)
    cfg = settings(db)
    P = People(db, cu, cfg)
    ids = [int(u) for u in dict.fromkeys(uids or []) if int(u) in P.by_id and int(u) != int(cu.id)]
    if not ids:
        raise HTTPException(422, "No one to remind")
    lbl = per_of("Week", a)["label"]
    stamp = now_ist().strftime("%d %b %H:%M")
    sent = 0
    for u in ids:
        if _notify(db, u, "Commitment not submitted", f"Please submit your commitment for {lbl} before {cfg['cutoff']} "
                   f"(reminder from {cu.full_name}, {stamp})", week_key(a), "commitment_reminder", email=True):
            sent += 1
    db.commit()
    return {"sent": sent, "names": [P.by_id[u]["name"] for u in ids], "week": lbl}


def _cutoff_at(a: date, cutoff: str) -> datetime:
    """When the week starting a closes for commitments."""
    if cutoff.startswith("Friday"):
        d, hm = a - timedelta(days=3), (17, 0)
    elif cutoff.startswith("Sunday"):
        d, hm = a - timedelta(days=1), (20, 0)
    else:
        d, hm = a, (18, 0) if "18:00" in cutoff else (11, 0)
    return datetime(d.year, d.month, d.day, *hm)


def _auto_cutoff_reminders(db: Session, C: Ctx, rows: list[dict[str, Any]], a: date) -> None:
    """Settings → Remind people who have not committed: once the cut-off of the current week has passed, everyone still
    without a commitment for it gets one in-app reminder (once per week – the notification is keyed by the week)."""
    try:
        if not C.cfg["remind"] or a != wk_start(C.today):
            return
        now = now_ist().replace(tzinfo=None)
        if now < _cutoff_at(a, C.cfg["cutoff"]):
            return
        from app.models.all_models import Notification
        key, lbl, sent = week_key(a), per_of("Week", a)["label"], 0
        for r in rows:
            if r["mgr"] or r["sub"]:
                continue
            if db.query(Notification.id).filter(Notification.user_id == r["id"], Notification.module == MODULE, Notification.record_id == key,
                                                Notification.action == "commitment_cutoff").first():
                continue
            _notify(db, r["id"], "Commitment cut-off passed", f"The cut-off ({C.cfg['cutoff']}) for {lbl} has passed and your commitment "
                    "has not been submitted yet", key, "commitment_cutoff")
            sent += 1
        if sent:
            db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning("commitment cut-off reminders skipped: %s", exc)


# ─── order payment receipts (Finance acknowledgement) ─────────────────────────

def _is_finance(db: Session, cu: User) -> bool:
    try:
        from app.services.instrument_service import is_finance
        return bool(is_finance(db, cu))
    except Exception:
        db.rollback()
        return user_has_permission(db, cu, "emdbg.approve")


def receipts(db: Session, cu: User, status: Optional[str]) -> list[dict[str, Any]]:
    if not (user_has_permission(db, cu, "workorders.view") or _is_finance(db, cu)):
        raise HTTPException(403, "You don't have access to order payments")
    q = db.query(OrderPaymentReceipt, WorkOrder.wo_number, WorkOrder.customer_name).join(WorkOrder, WorkOrder.id == OrderPaymentReceipt.wo_id)
    if status:
        q = q.filter(OrderPaymentReceipt.status == status)
    rows = q.order_by(OrderPaymentReceipt.received_on.desc(), OrderPaymentReceipt.id.desc()).limit(500).all()
    nm = {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_({r.recorded_by for r, _, _ in rows if r.recorded_by} | {r.acknowledged_by for r, _, _ in rows if r.acknowledged_by} or {-1})).all()}
    return [{"id": r.id, "wo_id": r.wo_id, "order": num, "customer": cust, "amount": f(r.amount), "received_on": iso(r.received_on), "mode": r.mode or "",
             "reference": r.reference or "", "status": r.status, "by": nm.get(r.recorded_by or 0, ""), "ack_by": nm.get(r.acknowledged_by or 0, ""),
             "ack_at": r.acknowledged_at.isoformat() if r.acknowledged_at else None} for r, num, cust in rows]


def record_receipt(db: Session, cu: User, body: dict[str, Any], request: Optional[Request]) -> dict[str, Any]:
    """Delegates to Orders & Projects (one receipt workflow: stage link, duplicate check, history, Finance queue)."""
    from app.services import order_payment_service as P
    from app.services.order_service import ensure_schema as ensure_orders, get_order
    if not user_has_permission(db, cu, "workorders.update"):
        raise HTTPException(403, "You don't have permission to record order payments")
    ensure_orders(db)
    w = get_order(db, cu, int(body.get("wo_id") or 0))
    P.ensure_plans(db, [w])
    sid = body.get("stage_id") or (P.next_balance(db, [w]).get(w.id) or {}).get("stage_id")
    return P.record_receipt(db, cu, request, w, {**body, "stage_id": sid, "reference": body.get("reference"), "received_on": body.get("received_on") or today_ist().isoformat(),
                                                 "mode": body.get("mode") or "RTGS"})


def acknowledge_receipt(db: Session, cu: User, rid: int, body: dict[str, Any], request: Optional[Request]) -> dict[str, Any]:
    from app.services import order_payment_service as P
    from app.services.order_service import ensure_schema as ensure_orders, get_order
    ensure_orders(db)
    r = db.query(OrderPaymentReceipt).filter(OrderPaymentReceipt.id == rid).first()
    if not r:
        raise HTTPException(404, "Receipt not found")
    st = body.get("status") or "Acknowledged"
    if st not in RECEIPT_STATUSES[1:]:
        raise HTTPException(422, "Unknown status")
    return P.acknowledge(db, cu, request, get_order(db, cu, r.wo_id), rid, body, credited=st == "Acknowledged")


# ─── audit ────────────────────────────────────────────────────────────────────

def _audit(db: Session, cu: User, request: Optional[Request], action: str, rid: Optional[int], desc: str, old: Any, new: Any) -> None:
    try:
        from app.core.logging import log_audit_db
        log_audit_db(db, cu.id, "kam", action, rid, get_request_ip(request) if request else "", desc, old_data=old, new_data=new, record_name=desc[:200])
    except Exception as exc:
        logger.warning("commitment audit failed: %s", exc)
