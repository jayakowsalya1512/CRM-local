"""Guarantees & Deposits (prototype v18 · Finance & Field → Guarantees & Deposits).

Request → head approval → Finance pays / issues → lodged (Active) → refund / release requested → received back →
Finance acknowledges → Released. Tender fees end at Paid (non-refundable); exemptions are recorded as Exempted.

* Records are ``emdbg`` rows (Customer 360, dashboards, reports and the legacy /emdbg API read them). The v18 lifecycle
  values are appended to emdbg.status; the request / Finance / refund / receipt / acknowledgement details live in
  instrument_profiles. Legacy statuses are shown with their v18 meaning (Expired / Renewed → Active, Encashed →
  Forfeited, Cancelled → Rejected) without rewriting the stored history.
* Expiry is calculated: an Active or Release Requested instrument past its validity is shown as Expired.
* Head approval uses the Approvals engine: module "emdbg", action "request" (below ₹50 lakh) or "request_50l"
  (₹50 lakh and above – configure Sales Head + Company Admin there). Approved → With Finance; rejected → Rejected
  (revise & resubmit); withdrawing cancels the pending approval.
* Bids & Tenders: tender_deposits holds each tender's EMD / tender fee / bid-security requirement. Bid work (stages
  from bid submission on) stays locked until every required deposit is entered and approved (dep_clear).
* Visibility follows emdbg.view + the legacy data scope; Finance actions need emdbg.approve or a Finance role.
* Amounts are DECIMAL end to end.
"""
from __future__ import annotations

import logging
import re
import threading
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy import bindparam, false, func, or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.timezone import now_ist, today_ist
from app.dependencies import get_request_ip, user_has_permission
from app.models.all_models import EMDBG, EMDBGRenewalHistory, Setting, Tender, User
from app.models.instruments import INSTRUMENT_TABLES, InstrumentProfile, InstrumentType, TenderDeposit

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

MODULE = "emdbg"
CENT = Decimal("0.01")
MAX_AMOUNT = Decimal("9999999999999.99")
HIGH_VALUE = Decimal("5000000")          # ₹50 lakh – Company Admin approval as well (action request_50l)
# v18 instrument types (prototype GDT): key, label, stored emdbg.instrument_type value, category, order
DEFAULT_TYPES = [("EMD", "EMD", "EMD", "deposit", 1), ("TF", "Tender fee", "Tender fee", "fee", 2), ("BG", "BG", "BG", "guarantee", 3),
                 ("PBG", "PBG", "Performance BG", "guarantee", 4), ("SD", "Security Deposit", "Security Deposit", "deposit", 5), ("FDR", "FDR", "FDR", "deposit", 6)]
LEGACY_TYPES = [("ABG", "Advance BG", "Advance BG", "guarantee", 7), ("RBG", "Retention BG", "Retention BG", "guarantee", 8),
                ("DD", "DD", "DD", "deposit", 9), ("ONLINE", "Online Payment", "Online Payment", "deposit", 10)]
PURPOSE = {"EMD": "Earnest money deposit", "TF": "Tender document fee", "BG": "Bid security bank guarantee", "PBG": "Performance bank guarantee",
           "SD": "Security deposit", "FDR": "Fixed deposit receipt (pledged)"}
MODES = ["Online – portal payment (e-tender)", "Online – NEFT / RTGS", "Demand draft", "Bank guarantee", "Insurance surety bond", "FDR (pledged)",
         "Exempted – MSE / Startup"]
EXEMPT = "Exempted – MSE / Startup"
STATUSES = ["Pending approval", "Rejected", "With Finance", "Active", "Paid", "Release Requested", "Received – ack pending", "Released", "Forfeited", "Exempted"]
TONE = {"Pending approval": "wa", "Rejected": "ba", "With Finance": "inf", "Active": "ok", "Paid": "ok", "Release Requested": "wa",
        "Received – ack pending": "inf", "Released": "mu", "Forfeited": "ba", "Exempted": "mu"}
LEGACY = {"Expired": "Active", "Renewed": "Active", "Encashed": "Forfeited", "Cancelled": "Rejected"}
RET_REASONS = ["Tender result declared – not awarded", "Tender cancelled by customer", "Contract performance complete", "Replaced by PBG", "Bid validity over"]
RECV_MODES = ["NEFT / RTGS credit", "Cheque", "Demand draft", "Adjusted against PBG"]
BANKS = ["SBI", "HDFC Bank", "ICICI Bank", "Canara Bank", "Axis Bank", "Indian Bank"]
PREFERRED_BANKS = ["SBI", "HDFC Bank", "ICICI Bank", "Axis Bank"]
DEP_KINDS = {"emd": "EMD", "fee": "TF", "bg": "BG"}                   # tender deposit → instrument type key
DEP_LABEL = {"emd": "EMD", "fee": "Tender fee", "bg": "Bid security BG"}

# Setup → Sales modules → Guarantees & deposits (tenant settings, category "instruments"): key, label, type, default
CONFIG_KEYS: dict[str, tuple[str, str, str, Any]] = {
    "remind_days": ("instrument_expiry_reminder_days", "Expiry reminder (days before)", "number", 30),
    "track_margin": ("instrument_track_margin", "Track bank margin / lien", "boolean", True),
    "release_approval": ("instrument_release_approval", "Approval to request release", "boolean", True),
    "auto_create": ("instrument_auto_create_emd", "Auto-create instrument when a bid needs EMD", "boolean", True),
    "preferred_bank": ("instrument_preferred_bank", "Preferred bank", "string", "SBI"),
    "escalate_days": ("instrument_escalate_days", "Escalate unreleased after (days)", "number", 45),
    "track_fdr": ("instrument_track_fdr", "Track FDR deposits", "boolean", True),
    "banks": ("instrument_banks", "Banks", "list", ",".join(BANKS)),
    "accounts": ("instrument_finance_accounts", "Company bank accounts (debit / credit)", "list", ""),
    "finance_roles": ("instrument_finance_roles", "Finance controller roles", "list", "accounts,finance_controller,finance"),
    # Expiry & alerts → Alert rules (each one switches the background notification on / off)
    "alert_expiring": ("instrument_alert_expiring", "EMD / BG expiring", "boolean", True),
    "alert_expired": ("instrument_alert_expired", "Instrument expired", "boolean", True),
    "alert_refund": ("instrument_alert_refund", "Refund not received", "boolean", True),
    "alert_received": ("instrument_alert_received", "Refund marked received", "boolean", True),
    "alert_finance": ("instrument_alert_finance", "Approved request waiting for Finance", "boolean", True),
    "alert_email": ("instrument_alert_email", "Also send alerts by email", "boolean", True),
}


class Bad(HTTPException):
    def __init__(self, msg: str, code: int = 422):
        super().__init__(code, msg)


def dec(v: Any) -> Decimal:
    if v is None or v == "":
        return Decimal(0)
    try:
        return v if isinstance(v, Decimal) else Decimal(str(v))
    except (InvalidOperation, ValueError):
        raise Bad("Enter a valid amount")


def q2(v: Decimal) -> Decimal:
    return v.quantize(CENT, rounding=ROUND_HALF_UP)


def fdt(d: Optional[date]) -> str:
    return d.strftime("%d %b %Y") if d else "—"


def inr(v: Any) -> str:
    return f"₹{dec(v):,.0f}"


def _iso(d) -> Optional[str]:
    return d.isoformat() if d else None


def _txt(v: Any, n: int) -> Optional[str]:
    s = str(v or "").strip()
    return s[:n] if s else None


# ─── schema ───────────────────────────────────────────────────────────────────

PROFILE_COLUMNS = [
    ("mode", "VARCHAR(60) NULL"), ("beneficiary", "VARCHAR(200) NULL"), ("payable_at", "VARCHAR(200) NULL"), ("required_by", "DATE NULL"),
    ("priority", "VARCHAR(10) NULL"), ("req_approval_id", "INT NULL"), ("approved_on", "DATETIME NULL"), ("approved_by", "INT NULL"),
    ("withdrawn", "TINYINT(1) NOT NULL DEFAULT 0"), ("utr", "VARCHAR(100) NULL"), ("txn_ref", "VARCHAR(100) NULL"), ("pay_date", "DATE NULL"),
    ("fin_by", "INT NULL"), ("debit_account", "VARCHAR(150) NULL"), ("charges", "DECIMAL(15,2) NULL"), ("pay_remarks", "TEXT NULL"), ("ret_on", "DATE NULL"),
    ("ret_letter", "VARCHAR(100) NULL"), ("recv_on", "DATE NULL"), ("recv_by", "INT NULL"), ("recv_amount", "DECIMAL(15,2) NULL"),
    ("recv_mode", "VARCHAR(60) NULL"), ("recv_ref", "VARCHAR(150) NULL"), ("recv_remarks", "TEXT NULL"), ("ack_on", "DATE NULL"), ("ack_by", "INT NULL"),
    ("ack_ref", "VARCHAR(100) NULL"), ("ack_amount", "DECIMAL(15,2) NULL"), ("ack_account", "VARCHAR(150) NULL"), ("ack_shortfall", "DECIMAL(15,2) NULL"),
    ("ack_remarks", "TEXT NULL"), ("forfeit_on", "DATE NULL"), ("forfeit_by", "INT NULL"), ("forfeit_reason", "TEXT NULL"), ("exempt_cert", "VARCHAR(150) NULL"),
    ("reminded_days", "INT NULL"), ("expired_alert_at", "DATETIME NULL"), ("fin_alert_on", "DATE NULL"),
]


def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        EMDBG.__table__.create(bind=bind, checkfirst=True)
        EMDBGRenewalHistory.__table__.create(bind=bind, checkfirst=True)
        for ddl in (   # values are only ever appended – stored history stays valid
            "ALTER TABLE emdbg MODIFY COLUMN instrument_type ENUM('EMD','Performance BG','Security Deposit','Advance BG','Retention BG','DD','Online Payment','BG','FDR',"
            "'Tender fee','EB') NOT NULL",
            "ALTER TABLE emdbg MODIFY COLUMN status ENUM('Active','Expired','Released','Encashed','Renewed','Cancelled','Release Requested','Pending approval',"
            "'Rejected','With Finance','Paid','Received – ack pending','Forfeited','Exempted') DEFAULT 'Active'",
            "ALTER TABLE org_tree_nodes ADD COLUMN IF NOT EXISTS description VARCHAR(500) NULL",   # Approvals engine ORM (see product_service)
        ):
            try:
                db.execute(text(ddl))
                db.commit()
            except Exception as exc:
                db.rollback()
                logger.warning("instruments schema: %s skipped: %s", ddl[:70], exc)
        for t in INSTRUMENT_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        for col, ddl in PROFILE_COLUMNS:
            db.execute(text(f"ALTER TABLE instrument_profiles ADD COLUMN IF NOT EXISTS `{col}` {ddl}"))
        db.execute(text("CREATE INDEX IF NOT EXISTS ix_instrument_profiles_req_approval ON instrument_profiles (req_approval_id)"))
        db.execute(text("CREATE INDEX IF NOT EXISTS ix_emdbg_status ON emdbg (status)"))
        db.commit()
        have = {r[0] for r in db.query(InstrumentType.key).all()}
        used = {r[0] for r in db.execute(text("SELECT DISTINCT instrument_type FROM emdbg")).all()}
        for k, label, stored, cat, order in DEFAULT_TYPES + LEGACY_TYPES:
            if k not in have:
                legacy = (k, label, stored, cat, order) in LEGACY_TYPES
                db.add(InstrumentType(key=k, label=label, stored_value=stored, category=cat, sort_order=order, is_active=not legacy or stored in used))
            else:
                db.query(InstrumentType).filter(InstrumentType.key == k).update({InstrumentType.sort_order: order}, synchronize_session=False)
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
            logger.warning("instruments schema: tenant %s unavailable: %s", slug, exc)
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
        except Exception as exc:
            logger.warning("instruments schema for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()


# ─── settings ─────────────────────────────────────────────────────────────────

def config(db: Session) -> dict[str, Any]:
    rows = {s.key: (s.value or "").strip() for s in db.query(Setting.key, Setting.value).filter(Setting.key.in_([k for k, _, _, _ in CONFIG_KEYS.values()])).all()}
    out: dict[str, Any] = {}
    for name, (key, _, typ, default) in CONFIG_KEYS.items():
        v = rows.get(key, "")
        if typ == "list":
            out[name] = [x.strip() for x in (v if key in rows else default).split(",") if x.strip()]
        elif v == "":
            out[name] = default
        elif typ == "boolean":
            out[name] = v.lower() in ("1", "true", "yes", "on")
        elif typ == "number":
            try:
                out[name] = max(1, min(3650, int(float(v))))
            except ValueError:
                out[name] = default
        else:
            out[name] = v
    if out["preferred_bank"] and out["preferred_bank"] not in out["banks"]:
        out["banks"] = [out["preferred_bank"]] + out["banks"]
    return out


def save_config(db: Session, cu: User, values: dict[str, Any]) -> dict[str, Any]:
    cur = config(db)
    nxt = dict(cur)
    for name, raw in values.items():
        if name not in CONFIG_KEYS or raw is None:
            continue
        _, label, typ, _ = CONFIG_KEYS[name]
        if typ == "boolean":
            nxt[name] = raw if isinstance(raw, bool) else str(raw).lower() in ("1", "true", "yes", "on")
        elif typ == "number":
            try:
                n = int(raw)
            except (TypeError, ValueError):
                raise Bad(f"{label} must be a whole number")
            if not 1 <= n <= 3650:
                raise Bad(f"{label} must be between 1 and 3650")
            nxt[name] = n
        elif typ == "list":
            items = raw if isinstance(raw, list) else str(raw).split(",")
            nxt[name] = [str(x).strip()[:100].replace(",", " ") for x in items if str(x).strip()]
        else:
            nxt[name] = str(raw).strip()
    if nxt["preferred_bank"] not in PREFERRED_BANKS + nxt["banks"]:
        raise Bad("Choose a preferred bank from the list")
    existing = {s.key: s for s in db.query(Setting).filter(Setting.key.in_([k for k, _, _, _ in CONFIG_KEYS.values()])).all()}
    for name, (key, label, typ, _) in CONFIG_KEYS.items():
        v = nxt[name]
        sv = ("true" if v else "false") if typ == "boolean" else ",".join(v) if typ == "list" else str(v)
        row = existing.get(key)
        if row is None:
            db.add(Setting(key=key, value=sv, type={"number": "number", "boolean": "boolean"}.get(typ, "string"), category="instruments", label=label, updated_by=cu.id))
        elif row.value != sv:
            row.value, row.updated_by = sv, cu.id
    if nxt["track_fdr"] != cur["track_fdr"]:
        db.query(InstrumentType).filter(InstrumentType.key == "FDR").update({InstrumentType.is_active: bool(nxt["track_fdr"])}, synchronize_session=False)
    from app.core.logging import log_audit_db
    log_audit_db(db, cu.id, MODULE, "settings_update", None, "", description="Guarantees & deposits settings updated",
                 old_data={k: cur[k] for k in CONFIG_KEYS}, new_data={k: nxt[k] for k in CONFIG_KEYS})
    db.commit()
    return config(db)


def types(db: Session, include_inactive: bool = False) -> list[dict[str, Any]]:
    cfg = config(db)
    out = []
    for t in db.query(InstrumentType).order_by(InstrumentType.sort_order, InstrumentType.key).all():
        active = bool(t.is_active) and (t.key != "FDR" or cfg["track_fdr"])
        if active or include_inactive:
            out.append({"key": t.key, "label": t.label, "stored": t.stored_value, "category": t.category, "active": active, "purpose": PURPOSE.get(t.key, t.label)})
    return out


def _type_maps(db: Session) -> tuple[dict[str, dict], dict[str, dict]]:
    all_t = types(db, include_inactive=True)
    return {t["key"]: t for t in all_t}, {t["stored"]: t for t in all_t}


# ─── permissions ──────────────────────────────────────────────────────────────

def is_finance(db: Session, cu: User) -> bool:
    return user_has_permission(db, cu, "emdbg.approve") or (cu.role or "").lower() in [r.lower() for r in config(db)["finance_roles"]]


def can(db: Session, cu: User) -> dict[str, bool]:
    upd = user_has_permission(db, cu, "emdbg.update")
    fin = is_finance(db, cu)
    return {"view": user_has_permission(db, cu, "emdbg.view"), "create": user_has_permission(db, cu, "emdbg.create"), "update": upd,
            "finance": fin, "forfeit": user_has_permission(db, cu, "emdbg.approve"), "export": user_has_permission(db, cu, "emdbg.export"),
            "settings": user_has_permission(db, cu, "settings.manage"), "sensitive": upd or fin}


def _need(ok: bool, what: str) -> None:
    if not ok:
        raise HTTPException(403, f"You do not have permission to {what}")


# ─── scope & rows ─────────────────────────────────────────────────────────────

def base_query(db: Session, cu: User):
    if not user_has_permission(db, cu, "emdbg.view"):
        return db.query(EMDBG).filter(false())
    from app.routers.emdbg_router import _apply_emdbg_scope
    return _apply_emdbg_scope(db.query(EMDBG), db, cu)


def get_instrument(db: Session, cu: User, iid: int, lock: bool = False) -> EMDBG:
    e = base_query(db, cu).filter(EMDBG.id == iid).first()
    if not e:
        raise HTTPException(404, "Instrument not found")
    if lock:
        db.execute(text("SELECT id FROM emdbg WHERE id = :i FOR UPDATE"), {"i": iid})
        db.refresh(e)
    return e


def profile(db: Session, e: EMDBG) -> InstrumentProfile:
    p = db.query(InstrumentProfile).filter(InstrumentProfile.emdbg_id == e.id).first()
    if p is None:
        _, by_stored = _type_maps(db)
        p = InstrumentProfile(emdbg_id=e.id, type_key=(by_stored.get(e.instrument_type) or {}).get("key"), release_state="none",
                              requested_on=e.created_at.date() if e.created_at else None)
        if e.status == "Release Requested":
            p.release_state = "requested"
        db.add(p)
        db.flush()
    return p


def status_of(e: EMDBG) -> str:
    return LEGACY.get(e.status or "Active", e.status or "Active")


def type_key(e: EMDBG, p: Optional[InstrumentProfile], by_stored: dict) -> str:
    return (p.type_key if p and p.type_key else None) or (by_stored.get(e.instrument_type) or {}).get("key") or e.instrument_type


def is_bg(tk: str, mode: Optional[str]) -> bool:
    return bool(re.search(r"Bank guarantee|surety|FDR", mode or "")) or tk in ("BG", "PBG", "FDR", "ABG", "RBG")


def expired(status: str, validity: Optional[date], today: date) -> bool:
    return status in ("Active", "Release Requested") and bool(validity) and validity < today


def next_step(r: dict, today: date) -> str:
    """Prototype gdNext()."""
    st, tk = r["status"], r["type_key"]
    if r["expired"]:
        return "Expired – claim refund or extend validity" if tk == "EMD" else "Expired – extend with the bank or release"
    days = (date.fromisoformat(r["validity"]) - today).days if r["validity"] else None
    return {"Pending approval": f"Waiting for {r['waiting_for']}" if r.get("waiting_for") else "Waiting for head approval",
            "With Finance": "Finance to " + ("issue the instrument" if r["bg"] and tk != "TF" else "pay and enter the UTR"),
            "Active": f"Expires in {days} d – plan extension or release" if days is not None and days <= 30 else "Lodged with the customer",
            "Paid": "Paid – non-refundable", "Release Requested": "Sales to follow up the refund / return",
            "Received – ack pending": "Finance to acknowledge the receipt", "Released": "Closed", "Rejected": "Rejected – revise and resubmit",
            "Forfeited": "Forfeited by the customer", "Exempted": "Exemption on file"}.get(st, "—")


def _waiting(db: Session, req_ids: list[int]) -> dict[int, str]:
    """Current pending approver (role · user) of each approval request."""
    if not req_ids:
        return {}
    from app.models.all_models import ApprovalRequest
    out = {}
    for r in db.query(ApprovalRequest).filter(ApprovalRequest.id.in_(req_ids)).all():
        if (r.status or "").lower() != "pending":
            continue
        step = next((s for s in sorted(r.steps or [], key=lambda x: x.step_no) if s.step_no == r.current_step_no), None)
        if step is not None:
            who = getattr(getattr(step, "approver", None), "full_name", None)
            out[r.id] = " · ".join(x for x in ((step.approver_role or "").replace("_", " ").title() or None, who) if x) or "the approver"
    return out


def list_rows(db: Session, cu: User) -> list[dict[str, Any]]:
    """All instruments the user may see as v18 register rows."""
    rows = base_query(db, cu).order_by(EMDBG.id.desc()).all()
    if not rows:
        return []
    ids = [e.id for e in rows]
    profs = {p.emdbg_id: p for p in db.query(InstrumentProfile).filter(InstrumentProfile.emdbg_id.in_(ids)).all()}
    tids = {e.tender_id for e in rows if e.tender_id}
    tenders = {t.id: t for t in db.query(Tender.id, Tender.tender_num, Tender.portal_ref_number, Tender.is_deleted).filter(Tender.id.in_(tids)).all()} if tids else {}
    wids = {e.work_order_id for e in rows if e.work_order_id}
    wos = {w.id: w.wo_number for w in db.execute(text("SELECT id, wo_number FROM work_orders WHERE id IN :i").bindparams(
        bindparam("i", expanding=True)), {"i": list(wids)}).all()} if wids else {}
    uids = {x for p in profs.values() for x in (p.approved_by, p.recv_by)} | {e.created_by for e in rows}
    who = {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_({u for u in uids if u})).all()}
    _, by_stored = _type_maps(db)
    pend_ids = {e.id for e in rows if e.status == "Pending approval"}
    waiting = _waiting(db, [p.req_approval_id for p in profs.values() if p.req_approval_id and p.emdbg_id in pend_ids])
    today = today_ist()
    out = []
    for e in rows:
        p = profs.get(e.id)
        t = tenders.get(e.tender_id)
        tk = type_key(e, p, by_stored)
        st = status_of(e)
        mode = (p.mode if p else None) or ("Bank guarantee" if tk in ("BG", "PBG") else "")
        r = {"id": e.id, "code": e.reference_num, "type": (by_stored.get(e.instrument_type) or {"label": e.instrument_type})["label"], "type_key": tk,
             "tender_id": e.tender_id if t and not t.is_deleted else None, "tender": (t.tender_num or f"TND-{t.id}") if t else (e.tender_num or ""),
             "tender_no": (t.portal_ref_number or "") if t else "", "wo_id": e.work_order_id, "wo": wos.get(e.work_order_id, ""),
             "customer": e.client_name or "", "customer_id": e.customer_id, "mode": mode, "amount": float(dec(e.amount)), "bank": e.bank_name or "",
             "requested": _iso((p.requested_on if p and p.requested_on else None) or (e.created_at.date() if e.created_at else None)),
             "requested_by": who.get(e.created_by, ""), "due": _iso(p.required_by) if p else None,
             "approved_on": _iso(p.approved_on.date()) if p and p.approved_on else None, "approved_by": who.get(p.approved_by, "") if p else "",
             "utr": (p.utr if p and p.utr else None) or (e.instrument_number if st not in ("Pending approval", "Rejected", "With Finance", "Exempted") else None) or "",
             "validity": _iso(e.expiry_date), "status": st, "recorded_status": e.status, "bg": is_bg(tk, mode),
             "ret_on": _iso(p.ret_on) if p and p.ret_on else (_iso(p.release_requested_at.date()) if p and p.release_requested_at else None),
             "recv_on": _iso(p.recv_on) if p else None, "recv_by": who.get(p.recv_by, "") if p else "", "recv_amount": float(p.recv_amount) if p and p.recv_amount is not None else None,
             "recv_ref": (p.recv_ref or "") if p else "", "priority": (p.priority or "") if p else "",
             "waiting_for": waiting.get(p.req_approval_id) if p and p.req_approval_id else None, "approval_id": p.req_approval_id if p else None}
        r["expired"] = expired(st, e.expiry_date, today)
        r["days"] = (e.expiry_date - today).days if e.expiry_date else None
        r["eff_status"] = "Expired" if r["expired"] else st
        r["tone"] = "ba" if r["expired"] else TONE.get(st, "inf")
        r["live"] = st in ("Active", "Release Requested", "Received – ack pending") and tk != "TF"
        r["next"] = next_step(r, today)
        out.append(r)
    return out


def summary(rows: list[dict]) -> dict[str, Any]:
    """Prototype gdOutstanding() + gdAlerts() + the view counts – Decimal sums over the visible instruments."""
    S = lambda L, k="amount": float(q2(sum((dec(r[k] if r[k] is not None else r["amount"]) for r in L), Decimal(0))))  # noqa: E731
    live = [r for r in rows if r["live"]]
    groups = [("EMD", "EMD"), ("BG", "Bid security BG"), ("PBG", "PBG"), ("SD", "Security deposit"), ("FDR", "FDR")]
    grp = [{"k": k, "l": l, "v": S([r for r in live if r["type_key"] == k]), "n": sum(1 for r in live if r["type_key"] == k)} for k, l in groups]
    other = [r for r in live if r["type_key"] not in {k for k, _ in groups}]
    if other:
        grp.append({"k": "OTHER", "l": "Other instruments", "v": S(other), "n": len(other)})
    pend = [r for r in rows if r["status"] == "Pending approval"]
    fin = [r for r in rows if r["status"] == "With Finance"]
    soon = [r for r in rows if r["status"] == "Active" and r["days"] is not None and 0 <= r["days"] <= 30]
    exp = [r for r in rows if r["expired"]]
    ack = [r for r in rows if r["status"] == "Received – ack pending"]
    fees = [r for r in rows if r["type_key"] == "TF" and r["status"] == "Paid"]
    kpis = [{"l": "Awaiting head approval", "n": len(pend), "v": S(pend), "view": "Awaiting approval", "c": "wa"},
            {"l": "With Finance to pay", "n": len(fin), "v": S(fin), "view": "Finance desk", "c": "inf"},
            {"l": "Expiring in 30 days", "n": len(soon), "v": S(soon), "view": "Expiry & alerts", "c": "wa"},
            {"l": "Expired – action needed", "n": len(exp), "v": S(exp), "view": "Expiry & alerts", "c": "ba"},
            {"l": "Refunds to acknowledge", "n": len(ack), "v": S(ack, "recv_amount"), "view": "Finance desk", "c": "inf"},
            {"l": "Tender fees paid (sunk)", "n": len(fees), "v": S(fees), "view": "Register", "c": "mu", "filter": {"type_key": "TF", "status": "Paid"}}]
    today = today_ist()
    soon15 = [r for r in soon if r["days"] <= 15]
    late = [r for r in rows if r["type_key"] == "EMD" and r["status"] == "Release Requested" and r["ret_on"] and (today - date.fromisoformat(r["ret_on"])).days > 30]
    ref = lambda r: r["tender"] or r["wo"] or "—"  # noqa: E731
    alerts = []
    if exp:
        alerts.append({"c": "ba", "t": f"{len(exp)} instrument{'s have' if len(exp) > 1 else ' has'} expired", "n": len(exp), "view": "Expiry & alerts",
                       "items": [{"id": r["id"], "s": f"{r['type']} {ref(r)} · {r['customer'][:28]} · expired {fdt(date.fromisoformat(r['validity']))}"} for r in exp[:3]]})
    if soon15:
        alerts.append({"c": "wa", "t": f"{len(soon15)} expiring within 15 days", "n": len(soon15), "view": "Expiry & alerts",
                       "items": [{"id": r["id"], "s": f"{r['type']} {ref(r)} · {r['customer'][:28]} · in {r['days']} d"} for r in soon15[:3]]})
    if ack:
        alerts.append({"c": "inf", "t": f"{len(ack)} refund{'s' if len(ack) > 1 else ''} marked received – Finance to acknowledge", "n": len(ack), "view": "Finance desk",
                       "items": [{"id": r["id"], "s": f"{r['type']} {ref(r)} · {inr(r['recv_amount'] if r['recv_amount'] is not None else r['amount'])} · {r['recv_by'] or '—'}"} for r in ack[:3]]})
    if late:
        alerts.append({"c": "wa", "t": f"{len(late)} EMD refund{'s' if len(late) > 1 else ''} pending over 30 days", "n": len(late), "view": "Expiry & alerts",
                       "items": [{"id": r["id"], "s": f"{ref(r)} · {r['customer'][:28]} · requested {fdt(date.fromisoformat(r['ret_on']))}"} for r in late[:3]]})
    alert_n = sum(1 for r in rows if r["expired"] or (r["status"] == "Active" and r["days"] is not None and 0 <= r["days"] <= 30))
    return {"outstanding": S(live), "live": len(live), "groups": grp, "kpis": kpis, "alerts": alerts,
            "counts": {"Register": len(rows), "Awaiting approval": len(pend), "Finance desk": len(fin) + len(ack), "Expiry & alerts": alert_n}}


# ─── tenders & orders ─────────────────────────────────────────────────────────

def _tender_access(db: Session, cu: User, tid: int) -> Tender:
    from app.services import bid_service
    try:
        return bid_service.get_bid(db, cu, int(tid))
    except HTTPException:
        raise Bad("Choose a tender you can access")


def deposit_config(db: Session, t: Tender) -> dict[str, dict[str, Any]]:
    """Prototype tdDep(): stored requirement, else derived from the tender (EMD / fee amounts) and its instruments."""
    rows = {d.kind: d for d in db.query(TenderDeposit).filter(TenderDeposit.tender_id == t.id).all()}
    sub = t.submission_date
    out = {}
    for k in DEP_KINDS:
        d = rows.get(k)
        amt = d.amount if d and d.amount is not None else (t.emd_amount if k == "emd" else t.tender_fee_amount if k == "fee" else None)
        if d:
            req = d.req
        elif k == "emd":
            req = "Required" if amt and dec(amt) > 0 else "Not required"
        elif k == "fee":
            req = "Required" if (amt and dec(amt) > 0) or getattr(t, "tender_fee_required", False) else "Not required"
        else:
            req = "Not required"
        bene = (d.beneficiary if d and d.beneficiary else None) or (t.emd_dd_in_favour_of if k == "emd" else t.tender_fee_dd_in_favour_of if k == "fee" else None) or t.customer_name
        at = (d.payable_at if d and d.payable_at else None) or (t.emd_dd_payable_at if k == "emd" else t.tender_fee_dd_payable_at if k == "fee" else None) or (t.site_loc or "")
        due = (d.required_by if d else None) or ((sub - timedelta(days=3 if k == "fee" else 2)) if sub else None)
        mode = (d.mode if d else None) or ("Bank guarantee" if k == "bg" or (amt and dec(amt) >= Decimal("2500000")) else "Online – portal payment (e-tender)")
        out[k] = {"req": req, "amount": float(dec(amt)) if amt is not None else None, "mode": mode, "bene": bene or "", "at": at or "", "due": _iso(due),
                  "cert": (d.cert or "") if d else "", "rm": (d.remarks or "") if d else ""}
    return out


def _save_deposit(db: Session, cu: User, t: Tender, kind: str, **vals) -> None:
    d = db.query(TenderDeposit).filter(TenderDeposit.tender_id == t.id, TenderDeposit.kind == kind).first()
    if d is None:
        cur = deposit_config(db, t)[kind]
        d = TenderDeposit(tender_id=t.id, kind=kind, req=cur["req"], amount=cur["amount"], mode=cur["mode"], beneficiary=cur["bene"], payable_at=cur["at"],
                          required_by=date.fromisoformat(cur["due"]) if cur["due"] else None)
        db.add(d)
    for k, v in vals.items():
        setattr(d, k, v)
    d.updated_by = cu.id
    if kind == "emd" and vals.get("amount") is not None:
        t.emd_amount, t.emd_required = vals["amount"], bool(vals["amount"])
    if kind == "fee" and vals.get("amount") is not None:
        t.tender_fee_amount, t.tender_fee_required = vals["amount"], bool(vals["amount"])


def _tender_instrument(db: Session, t: Tender, tk: str, by_key: dict) -> Optional[tuple[EMDBG, InstrumentProfile]]:
    stored = (by_key.get(tk) or {}).get("stored", tk)
    rows = (db.query(EMDBG, InstrumentProfile).outerjoin(InstrumentProfile, InstrumentProfile.emdbg_id == EMDBG.id)
            .filter(EMDBG.tender_id == t.id, EMDBG.instrument_type == stored).order_by(EMDBG.id.desc()).all())
    rows = [(e, p) for e, p in rows if status_of(e) != "Rejected"]
    return rows[0] if rows else None


def dep_clear(db: Session, t: Tender) -> dict[str, Any]:
    """Prototype depClear(): every required deposit must be entered and past head approval."""
    by_key, _ = _type_maps(db)
    cfg = deposit_config(db, t)
    miss = []
    for k, tk in DEP_KINDS.items():
        if cfg[k]["req"] != "Required":
            continue
        x = _tender_instrument(db, t, tk, by_key)
        if not x:
            miss.append(f"{DEP_LABEL[k]} not entered")
        else:
            st = status_of(x[0])
            if st in ("Pending approval", "Rejected"):
                miss.append(f"{DEP_LABEL[k]} " + ("awaiting approval" if st == "Pending approval" else "rejected"))
    return {"ok": not miss, "missing": miss}


def check_bid_gate(db: Session, t: Tender, target: dict, stages: list[dict]) -> None:
    """Bids & Tenders: moving forward to the bid-submission stage (or beyond / won) needs cleared deposits."""
    opens = [s for s in stages if s["kind"] == "open"]
    si = next((i for i, s in enumerate(opens) if re.search(r"submi", s["name"], re.I)), min(2, max(0, len(opens) - 1)))
    ti = next((i for i, s in enumerate(opens) if s["id"] == target["id"]), None)
    if not ((ti is not None and ti >= si) or target["kind"] == "won"):
        return
    ensure_schema(db)
    g = dep_clear(db, t)
    if not g["ok"]:
        raise HTTPException(422, {"message": f"Cannot move to “{target['name']}” – " + ", ".join(g["missing"]) + " (Guarantees & Deposits)", "deposits": g["missing"]})


def by_tender(db: Session, cu: User) -> list[dict[str, Any]]:
    from app.services import bid_service
    trows, _ = bid_service.list_rows(db, cu)
    by_key, _ = _type_maps(db)
    tenders = {t.id: t for t in db.query(Tender).filter(Tender.id.in_([r["id"] for r in trows] or [-1])).all()}
    today = today_ist()
    out = []
    for r in trows:
        t = tenders.get(r["id"])
        if not t:
            continue
        cfg = deposit_config(db, t)
        cells, live_any = {}, False
        for k, tk in DEP_KINDS.items():
            x = _tender_instrument(db, t, tk, by_key) if cfg[k]["req"] != "Not required" else None
            c = {"req": cfg[k]["req"], "amount": cfg[k]["amount"]}
            if x:
                e, p = x
                st = status_of(e)
                ex = expired(st, e.expiry_date, today)
                c.update({"id": e.id, "status": "Expired" if ex else st, "tone": "ba" if ex else TONE.get(st, "inf"), "amount": float(dec(e.amount))})
                live_any = live_any or (st in ("Active", "Release Requested", "Received – ack pending") and tk != "TF")
            cells[k] = c
        if r["stage_kind"] == "lost" and not live_any:
            continue
        g = dep_clear(db, t)
        out.append({"id": t.id, "ref": r["ref"], "title": r["title"], "customer": r["customer"], "stage": r["stage"], "stage_kind": r["stage_kind"],
                    "submit": r["submit"], "emd": cells["emd"], "fee": cells["fee"], "bg": cells["bg"], "gate": g})
    return out


def tender_options(db: Session, cu: User, q: str = "") -> list[dict[str, Any]]:
    from app.services import bid_service
    trows, _ = bid_service.list_rows(db, cu)
    ql = q.strip().lower()
    return [{"id": r["id"], "ref": r["ref"], "customer": r["customer"], "title": r["title"], "stage": r["stage"]} for r in trows
            if r["stage_kind"] != "lost" and (not ql or ql in f"{r['ref']} {r['customer']} {r['title']} {r['nit']}".lower())][:200]


def order_options(db: Session, cu: User) -> list[dict[str, Any]]:
    if not user_has_permission(db, cu, "workorders.view"):
        return []
    rows = db.execute(text("SELECT id, wo_number, customer_name, project_title, po_number, po_value, wo_value, retention_percent, tender_id, delivery_date "
                           "FROM work_orders ORDER BY id DESC LIMIT 300")).mappings().all()
    return [{"id": r["id"], "ref": r["wo_number"], "customer": r["customer_name"] or "", "title": r["project_title"] or "", "po": r["po_number"] or "",
             "value": float(r["wo_value"] or r["po_value"] or 0), "retention": float(r["retention_percent"]) if r["retention_percent"] is not None else None,
             "tender_id": r["tender_id"], "due": _iso(r["delivery_date"])} for r in rows]


def defaults(db: Session, cu: User, tender_id: Optional[int], wo_id: Optional[int], tk: str) -> dict[str, Any]:
    """Pre-fill of the New request modal from the tender's deposit configuration / the order's rules."""
    cfg = config(db)
    out: dict[str, Any] = {"amount": None, "mode": "Bank guarantee" if tk in ("BG", "PBG") else "Online – portal payment (e-tender)", "due": None, "bene": "",
                           "at": "", "bank": cfg["preferred_bank"], "customer": "", "tender_no": "", "rule": ""}
    if tender_id:
        t = _tender_access(db, cu, tender_id)
        dc = deposit_config(db, t)
        k = next((k for k, v in DEP_KINDS.items() if v == tk), None)
        out.update({"customer": t.customer_name or "", "tender_no": t.portal_ref_number or "", "bene": t.customer_name or "", "at": t.site_loc or "",
                    "due": _iso(t.submission_date - timedelta(days=2)) if t.submission_date else None})
        if k:
            d = dc[k]
            out.update({"amount": d["amount"], "mode": d["mode"], "due": d["due"], "bene": d["bene"], "at": d["at"], "req": d["req"], "cert": d["cert"]})
        elif tk == "PBG":
            from app.services import bid_service
            bc = bid_service.config(db)
            prof = db.execute(text("SELECT pbg_pct FROM bid_profiles WHERE tender_id = :t"), {"t": t.id}).first()
            pct = float(prof[0]) if prof and prof[0] is not None else float(bc.get("pbg_pct") or 0)
            base = float(t.wo_value or t.po_value or t.est_value or 0)
            if pct and base:
                out["amount"], out["rule"] = round(base * pct / 100, 2), f"PBG {pct:g}% of {inr(base)} (bid settings)"
    if wo_id:
        w = next((x for x in order_options(db, cu) if x["id"] == int(wo_id)), None)
        if not w:
            raise Bad("Choose an order you can access")
        out.update({"customer": w["customer"], "bene": w["customer"], "due": w["due"], "mode": "Bank guarantee" if tk == "PBG" else "Online – NEFT / RTGS"})
        if tk == "SD" and w["retention"]:
            out["amount"], out["rule"] = round(w["value"] * w["retention"] / 100, 2), f"Retention {w['retention']:g}% of {inr(w['value'])} (order terms)"
        elif tk == "PBG" and w["tender_id"]:
            prof = db.execute(text("SELECT pbg_pct FROM bid_profiles WHERE tender_id = :t"), {"t": w["tender_id"]}).first()
            if prof and prof[0] is not None and w["value"]:
                out["amount"], out["rule"] = round(w["value"] * float(prof[0]) / 100, 2), f"PBG {float(prof[0]):g}% of {inr(w['value'])} (bid)"
    return out


# ─── audit / notifications ────────────────────────────────────────────────────

def _log(db: Session, cu: Optional[User], request: Optional[Request], e: EMDBG, action: str, description: str,
         old: Optional[dict] = None, new: Optional[dict] = None) -> None:
    from app.core.logging import log_module_action            # audit_logs + activity_logs (immutable Activity history)
    log_module_action(db=db, user_id=cu.id if cu else None, module=MODULE, action=action, record_id=e.id, record_name=e.reference_num,
                      ip=get_request_ip(request) if request else "", old_data=old, new_data=new, description=description)


def notify(db: Session, uids, title: str, msg: str, rid: int, action: str, email: Optional[bool] = None) -> int:
    from app.services.notification_service import upsert_notification
    send_email = config(db)["alert_email"] if email is None else email
    n = 0
    for uid in {u for u in uids if u}:
        try:
            upsert_notification(db, uid, title, msg, module=MODULE, record_id=rid, action=action, action_url=f"/emdbg?open={rid}", send_email=send_email)
            n += 1
        except Exception as exc:
            logger.warning("instrument notification failed: %s", exc)
    return n


def finance_users(db: Session) -> list[int]:
    roles = [r.lower() for r in config(db)["finance_roles"]]
    return [u.id for u in db.query(User.id, User.role).filter(User.is_active == True).all() if (u.role or "").lower() in roles]  # noqa: E712


def _owners(db: Session, e: EMDBG) -> list[int]:
    out = [e.created_by]
    if e.tender_id:
        out.append(db.query(Tender.assigned_to).filter(Tender.id == e.tender_id).scalar())
    return out


def emit(db: Session, e: EMDBG, event: str, actor: Optional[User]) -> None:
    try:
        from app.routers.emdbg_router import _emit_emdbg_event
        _emit_emdbg_event(db, record=e, event_key=event, actor=actor)
    except Exception as exc:
        logger.warning("instrument event %s failed: %s", event, exc)


def _tenant_id(request: Optional[Request]) -> Optional[int]:
    return getattr(getattr(request.state, "tenant", None), "id", None) if request else None


def _label(e: EMDBG) -> str:
    return f"{e.instrument_type} {inr(e.amount)} for {e.tender_num or e.client_name}"


# ─── new request ──────────────────────────────────────────────────────────────

def _clean_date(v: Any, label: str) -> Optional[date]:
    if v in (None, ""):
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise Bad(f"{label} must be a date")


def validate_request(db: Session, cu: User, body: dict[str, Any], current: Optional[EMDBG] = None) -> dict[str, Any]:
    by_key, _ = _type_maps(db)
    tk = body.get("type") or ""
    tp = by_key.get(tk)
    if not tp or tk not in {k for k, *_ in DEFAULT_TYPES} or not tp["active"]:
        raise Bad("Choose the instrument: EMD, Tender fee, BG, PBG, Security Deposit or FDR")
    tender = wo = None
    if body.get("tender_id"):
        tender = _tender_access(db, cu, body["tender_id"])
    elif body.get("wo_id"):
        w = next((x for x in order_options(db, cu) if x["id"] == int(body["wo_id"])), None)
        if not w:
            raise Bad("Choose an order you can access")
        if tk not in ("PBG", "SD", "BG", "FDR"):
            raise Bad("Against an order choose PBG, Security Deposit, BG or FDR")
        wo = w
    else:
        raise Bad("Choose the tender this request is against")
    mode = body.get("mode") or ""
    if mode not in MODES:
        raise Bad("Choose the mode of payment")
    exempt = mode == EXEMPT
    if exempt and tk not in ("EMD", "TF"):
        raise Bad("Only EMD and tender fee can be exempted")
    amount = dec(body.get("amount"))
    if amount < 0 or amount > MAX_AMOUNT or (amount == 0 and not exempt):
        raise Bad("Enter an amount greater than zero")
    due = _clean_date(body.get("due"), "Required by")
    if not due and not exempt:
        raise Bad("Enter the required-by date")
    if due and not current and due < today_ist():
        raise Bad("Required by cannot be in the past")
    bene = _txt(body.get("bene"), 200)
    if not bene and not exempt:
        raise Bad("Enter the beneficiary")
    cert = _txt(body.get("cert"), 150) if exempt else None
    if exempt and (not cert or len(cert) < 4):
        raise Bad("Enter the exemption certificate / reference (MSE / Udyam or Startup India number)")
    bank = _txt(body.get("bank"), 100)
    if bank and bank not in config(db)["banks"]:
        raise Bad("Choose a bank from the configured list")
    # one live request per tender / order and instrument type, unless an authorised user overrides
    q = db.query(EMDBG.id, EMDBG.reference_num, EMDBG.status).filter(EMDBG.instrument_type == tp["stored"])
    q = q.filter(EMDBG.tender_id == tender.id) if tender else q.filter(EMDBG.work_order_id == wo["id"])
    if current:
        q = q.filter(EMDBG.id != current.id)
    dup = next((r for r in q.all() if LEGACY.get(r.status, r.status) not in ("Rejected", "Released", "Forfeited")), None)
    if dup and not (body.get("allow_duplicate") and user_has_permission(db, cu, "emdbg.approve")):
        raise HTTPException(409, {"message": f"{tp['label']} for this {'tender' if tender else 'order'} is already on {dup.reference_num} ({LEGACY.get(dup.status, dup.status)})",
                                  "duplicate_id": dup.id})
    cust_name = (tender.customer_name if tender else wo["customer"]) or "—"
    cust_id = tender.customer_id if tender else db.execute(text("SELECT customer_id FROM work_orders WHERE id = :i"), {"i": wo["id"]}).scalar()
    return {"tp": tp, "tk": tk, "tender": tender, "wo": wo, "mode": mode, "exempt": exempt, "amount": q2(amount), "due": due, "bene": bene, "at": _txt(body.get("at"), 200),
            "bank": bank or config(db)["preferred_bank"], "remarks": _txt(body.get("remarks"), 2000), "cert": cert, "customer_id": cust_id, "customer": cust_name}


def _send_for_approval(db: Session, cu: User, request: Optional[Request], e: EMDBG, p: InstrumentProfile) -> str:
    from app.services.generic_approval_engine import create_generic_approval_request
    action = "request_50l" if dec(e.amount) >= HIGH_VALUE else "request"
    req = create_generic_approval_request(db, tenant_id=_tenant_id(request), requester=cu, module_key=MODULE, action_key=action, record_id=e.id)
    p.req_approval_id = req.id
    if (req.status or "").strip().lower() == "approved":
        _to_finance(db, cu, e, p, auto=("Auto-approved (no approval rule)" if (req.approval_mode or "") == "auto" else f"{cu.full_name} (top of approval hierarchy)"))
        return "Approved – sent to Finance"
    e.status, e.approval_status, e.approval_id = "Pending approval", "pending", req.id
    waiting = _waiting(db, [req.id]).get(req.id)
    notify(db, [s.approver_user_id for s in (req.steps or []) if s.step_no == req.current_step_no], "Guarantee / deposit approval needed",
           f"{cu.full_name} requested {_label(e)} – approval needed.", e.id, "approval_required")
    return f"Sent for approval{f' to {waiting}' if waiting else ''}"


def _to_finance(db: Session, actor: Optional[User], e: EMDBG, p: InstrumentProfile, auto: Optional[str] = None) -> None:
    e.status, e.approval_status, e.updated_at = "With Finance", "approved", now_ist()
    p.approved_on, p.approved_by = now_ist(), actor.id if actor else None
    tk = p.type_key or ""
    _log(db, actor, None, e, "approved", ("Approved" + (f" – {auto}" if auto else f" by {actor.full_name if actor else 'approver'}")) + " – sent to Finance",
         old={"status": "Pending approval"}, new={"status": "With Finance"})
    notify(db, finance_users(db), "Finance payment pending",
           f"{_label(e)} approved – Finance to {'arrange the instrument' if is_bg(tk, p.mode) and tk != 'TF' else 'pay and enter the UTR'}.", e.id, "finance_pending")
    notify(db, _owners(db, e), "Request approved", f"{_label(e)} was approved and sent to Finance.", e.id, "request_approved")


def create_request(db: Session, cu: User, request: Optional[Request], v: dict[str, Any], auto_key: Optional[str] = None) -> tuple[EMDBG, str]:
    from app.routers.emdbg_router import _ref_num
    for attempt in range(3):
        e = EMDBG(reference_num=_ref_num(db), instrument_number=v["cert"] if v["exempt"] else None, instrument_type=v["tp"]["stored"], amount=v["amount"],
                  bank_name=v["bank"], tender_id=v["tender"].id if v["tender"] else None, tender_num=(v["tender"].tender_num if v["tender"] else None),
                  work_order_id=v["wo"]["id"] if v["wo"] else None, po_number=v["wo"]["po"] if v["wo"] else None, customer_id=v["customer_id"],
                  client_name=v["customer"], currency="INR", status="Exempted" if v["exempt"] else "Pending approval",
                  approval_status="none", renewal_status="none", notes=v["remarks"], created_by=cu.id)
        db.add(e)
        try:
            with db.begin_nested():
                db.flush()
            break
        except IntegrityError:
            if attempt == 2:
                raise HTTPException(409, "Could not allocate an instrument ID – try again")
    pri = "High" if v["amount"] >= HIGH_VALUE or (v["due"] and (v["due"] - today_ist()).days <= 3) else "Medium"
    p = InstrumentProfile(emdbg_id=e.id, type_key=v["tk"], requested_on=today_ist(), release_state="none", auto_key=auto_key, mode=v["mode"], beneficiary=v["bene"],
                          payable_at=v["at"], required_by=v["due"], priority=pri, exempt_cert=v["cert"] if v["exempt"] else None)
    db.add(p)
    db.flush()
    if v["tender"]:
        k = next((k for k, tk in DEP_KINDS.items() if tk == v["tk"]), None)
        if k:   # the tender's deposit configuration follows the request (prototype gdCreate)
            _save_deposit(db, cu, v["tender"], k, req="Exempted" if v["exempt"] else "Required", amount=v["amount"] if v["amount"] else None, mode=v["mode"],
                          beneficiary=v["bene"], payable_at=v["at"], required_by=v["due"], cert=v["cert"] if v["exempt"] else None)
    if v["exempt"]:
        _log(db, cu, request, e, "create", f"{v['tp']['label']} exemption recorded – {v['cert']}", new={"type": v["tk"], "mode": v["mode"], "cert": v["cert"]})
        msg = "Exemption recorded"
    else:
        _log(db, cu, request, e, "create", f"Request raised – {v['tp']['label']} {inr(v['amount'])} · {v['mode']}",
             new={"type": v["tk"], "amount": float(v["amount"]), "mode": v["mode"], "due": _iso(v["due"]), "tender_id": e.tender_id, "wo_id": e.work_order_id})
        msg = _send_for_approval(db, cu, request, e, p)
    emit(db, e, "created", cu)
    return e, msg


def withdraw(db: Session, cu: User, request: Request, e: EMDBG) -> None:
    p = profile(db, e)
    if status_of(e) != "Pending approval":
        raise HTTPException(409, "Only requests waiting for approval can be withdrawn")
    if e.created_by != cu.id and not user_has_permission(db, cu, "emdbg.update"):
        raise HTTPException(403, "Only the requester can withdraw this request")
    if p.req_approval_id:
        from app.models.all_models import ApprovalRequest
        req = db.get(ApprovalRequest, p.req_approval_id)
        if req and (req.status or "").lower() == "pending":
            req.status, req.final_decided_at = "withdrawn", now_ist()
            for s in req.steps or []:
                if (s.status or "").lower() == "pending":
                    s.status, s.remarks = "withdrawn", "Request withdrawn by the requester"
    e.status, e.approval_status, e.updated_at = "Rejected", "withdrawn", now_ist()
    p.withdrawn = True
    _log(db, cu, request, e, "withdrawn", "Request withdrawn – approval cancelled", old={"status": "Pending approval"}, new={"status": "Rejected"})


def resubmit(db: Session, cu: User, request: Request, e: EMDBG, body: dict[str, Any]) -> str:
    p = profile(db, e)
    if status_of(e) != "Rejected":
        raise HTTPException(409, "Only rejected requests can be revised and resubmitted")
    v = validate_request(db, cu, {"type": p.type_key, "tender_id": e.tender_id, "wo_id": e.work_order_id, "amount": body.get("amount", e.amount),
                                  "mode": body.get("mode", p.mode), "due": body.get("due", p.required_by), "bene": body.get("bene", p.beneficiary),
                                  "at": body.get("at", p.payable_at), "bank": body.get("bank", e.bank_name), "remarks": body.get("remarks", e.notes)}, current=e)
    if v["exempt"]:
        raise Bad("Record an exemption as a new request")
    old = {"amount": float(dec(e.amount)), "mode": p.mode, "due": _iso(p.required_by)}
    e.amount, e.bank_name, e.notes = v["amount"], v["bank"], v["remarks"]
    p.mode, p.required_by, p.beneficiary, p.payable_at, p.withdrawn = v["mode"], v["due"], v["bene"], v["at"], False
    p.requested_on, p.approved_on, p.approved_by = today_ist(), None, None
    _log(db, cu, request, e, "resubmitted", "Revised and resubmitted for approval", old=old, new={"amount": float(v["amount"]), "mode": v["mode"], "due": _iso(v["due"])})
    return _send_for_approval(db, cu, request, e, p)


# ─── Finance: pay / issue ─────────────────────────────────────────────────────

def pay(db: Session, cu: User, request: Request, e: EMDBG, b: dict[str, Any]) -> None:
    _need(is_finance(db, cu), "enter payments or issue instruments (Finance)")
    p = profile(db, e)
    if status_of(e) != "With Finance":
        raise HTTPException(409, "Only approved requests waiting for Finance can be paid or issued")
    tk = p.type_key or ""
    bg = is_bg(tk, p.mode) and tk != "TF"
    today = today_ist()
    pdate = _clean_date(b.get("pay_date"), "Payment / issue date") or today
    if pdate > today:
        raise Bad("The payment / issue date cannot be in the future")
    cfg = config(db)
    if bg:
        ref = _txt(b.get("ref"), 100)
        if not ref:
            raise Bad("Enter the BG / bond / FDR number")
        validity = _clean_date(b.get("validity"), "Valid until")
        if not validity or validity <= pdate:
            raise Bad("Enter a validity date after the issue date")
        bank = _txt(b.get("bank"), 100) or e.bank_name
        if bank and bank not in cfg["banks"] and bank != e.bank_name:
            raise Bad("Choose a bank from the configured list")
        mp = dec(b.get("margin_pct")) if b.get("margin_pct") not in (None, "") else None
        if mp is not None and not (0 <= mp <= 100):
            raise Bad("Bank margin must be 0–100 %")
        ma = dec(b.get("margin_amount")) if b.get("margin_amount") not in (None, "") else (q2(dec(e.amount) * mp / 100) if mp is not None else None)
        if ma is not None and ma < 0:
            raise Bad("Margin / lien amount must be zero or more")
        dupe = db.query(EMDBG.reference_num).filter(func.lower(func.trim(EMDBG.instrument_number)) == ref.lower(), EMDBG.id != e.id, EMDBG.bank_name == bank).first()
        if dupe:
            raise HTTPException(409, f"{ref} is already recorded on {dupe[0]}")
        e.instrument_number, e.bank_name, e.issued_date, e.valid_from, e.expiry_date = ref, bank, pdate, pdate, validity
        if cfg["track_margin"]:
            p.margin_pct, p.margin_amount = (q2(mp) if mp is not None else None), (q2(ma) if ma is not None else None)
        what = f"Instrument issued – {ref} · {bank or ''} · valid till {fdt(validity)}"
    else:
        dd = p.mode == "Demand draft"
        utr = _txt(b.get("utr"), 100)
        ref = _txt(b.get("ref"), 100)
        if dd and not ref:
            raise Bad("Enter the DD number")
        if not dd and not utr:
            raise Bad("Enter the UTR / transaction reference")
        if utr and not re.fullmatch(r"[A-Za-z0-9/\-_. ]{4,100}", utr):
            raise Bad("The UTR can contain letters, digits and - / _ . (4–100 characters)")
        validity = _clean_date(b.get("validity"), "Refund due by") if tk not in ("TF",) else None
        if validity and validity < pdate:
            raise Bad("Refund due by cannot be before the payment date")
        p.utr, p.txn_ref = utr, _txt(b.get("txn_ref"), 100)
        e.instrument_number = ref or utr
        e.issued_date, e.valid_from = pdate, pdate
        if validity:
            e.expiry_date = validity
        p.debit_account = _txt(b.get("account"), 150)
        what = ("Paid" if tk == "TF" else "Paid / issued") + f" – {'DD ' + ref if dd else 'UTR ' + utr}"
    ch = dec(b.get("charges")) if b.get("charges") not in (None, "") else None
    if ch is not None and ch < 0:
        raise Bad("Bank charges must be zero or more")
    p.charges, p.pay_remarks, p.pay_date, p.fin_by = (q2(ch) if ch is not None else None), _txt(b.get("remarks"), 2000), pdate, cu.id
    e.finance_status, e.finance_paid_date, e.finance_paid_by, e.finance_notes = "paid", pdate, cu.id, p.pay_remarks
    e.status, e.updated_at = ("Paid" if tk == "TF" else "Active"), now_ist()
    _log(db, cu, request, e, "finance_paid", f"{what} by {cu.full_name}", old={"status": "With Finance"},
         new={"status": e.status, "utr": p.utr, "ref": e.instrument_number, "validity": _iso(e.expiry_date), "charges": float(p.charges) if p.charges is not None else None})
    emit(db, e, "issued", cu)
    notify(db, _owners(db, e), "Instrument issued" if bg else "Payment made", f"{_label(e)} {'issued' if bg else 'paid'} – {e.instrument_number or p.utr}.", e.id, "issued")


# ─── refund / release, receipt, acknowledgement ───────────────────────────────

def request_refund(db: Session, cu: User, request: Request, e: EMDBG, b: dict[str, Any]) -> dict[str, Any]:
    p = profile(db, e)
    st = status_of(e)
    if st != "Active" or p.type_key == "TF":
        raise HTTPException(409, "Refund / release can be requested only for an Active refundable instrument")
    if p.release_state == "pending_approval":
        raise HTTPException(409, "A release request is already waiting for approval")
    on = _clean_date(b.get("on"), "Requested on") or today_ist()
    if on > today_ist() or (p.pay_date and on < p.pay_date):
        raise Bad("The request date must be between the payment / issue date and today")
    reason = b.get("reason") or ""
    if reason not in RET_REASONS:
        raise Bad("Choose the reason for the refund / release")
    p.ret_on, p.ret_letter, p.release_reason, p.release_requested_by, p.release_requested_at = on, _txt(b.get("letter"), 100), reason, cu.id, now_ist()
    if config(db)["release_approval"]:
        from app.services.generic_approval_engine import create_generic_approval_request
        req = create_generic_approval_request(db, tenant_id=_tenant_id(request), requester=cu, module_key=MODULE, action_key="release_request", record_id=e.id)
        p.release_approval_id = req.id
        if (req.status or "").strip().lower() != "approved":
            p.release_state = "pending_approval"
            _log(db, cu, request, e, "release_requested", f"Refund / release request sent for approval – {reason}" + (f" · {p.ret_letter}" if p.ret_letter else ""),
                 new={"approval_request_id": req.id, "reason": reason})
            return {"status": "pending", "message": "Refund / release request sent for approval (Settings → Approval to request release)"}
    _set_release_requested(db, cu, request, e, p)
    return {"status": "requested", "message": f"Refund requested – follow up with {e.client_name}"}


def _set_release_requested(db: Session, actor: Optional[User], request: Optional[Request], e: EMDBG, p: InstrumentProfile) -> None:
    e.status, e.updated_at = "Release Requested", now_ist()
    p.release_state = "requested"
    _log(db, actor, request, e, "release_requested", f"Refund / release requested – {p.release_reason or ''}" + (f" · {p.ret_letter}" if p.ret_letter else ""),
         old={"status": "Active"}, new={"status": "Release Requested", "on": _iso(p.ret_on)})
    notify(db, _owners(db, e) + [p.release_requested_by], "Refund requested",
           f"Refund / release of {_label(e)} was requested from {e.client_name} – follow up until it is received.", e.id, "refund_requested")


def receive(db: Session, cu: User, request: Request, e: EMDBG, b: dict[str, Any]) -> None:
    _need(user_has_permission(db, cu, "emdbg.update"), "mark instruments received")
    p = profile(db, e)
    st = status_of(e)
    if st not in ("Active", "Release Requested") or p.type_key == "TF":
        raise HTTPException(409, "Only Active or Release Requested instruments can be marked received back")
    bg = is_bg(p.type_key or "", p.mode)
    on = _clean_date(b.get("on"), "Received on") or today_ist()
    if on > today_ist() or (p.pay_date and on < p.pay_date):
        raise Bad("The received date must be between the payment / issue date and today")
    if bg:
        ref = _txt(b.get("ref"), 150)
        amt = dec(e.amount)
        p.recv_mode = "Original returned"
    else:
        amt = dec(b.get("amount"))
        if amt <= 0 or amt > dec(e.amount):
            raise Bad(f"Amount received must be more than 0 and at most {inr(e.amount)}")
        mode = b.get("mode") or ""
        if mode not in RECV_MODES:
            raise Bad("Choose how it was received")
        ref = _txt(b.get("ref"), 150)
        p.recv_mode = mode
    p.recv_on, p.recv_by, p.recv_amount, p.recv_ref, p.recv_remarks = on, cu.id, q2(amt), ref, _txt(b.get("remarks"), 2000)
    old = st
    e.status, e.return_status, e.updated_at = "Received – ack pending", "received", now_ist()
    _log(db, cu, request, e, "received", f"Marked as received back – {'original returned' if bg else inr(amt)}" + (f" · {ref}" if ref else ""),
         old={"status": old}, new={"status": e.status, "amount": float(amt), "on": on.isoformat()})
    if config(db)["alert_received"]:
        notify(db, finance_users(db), "Refund marked received", f"{cu.full_name} marked {_label(e)} as received – Finance to acknowledge.", e.id, "ack_pending")


def acknowledge(db: Session, cu: User, request: Request, e: EMDBG, b: dict[str, Any]) -> dict[str, Any]:
    _need(is_finance(db, cu), "acknowledge receipts (Finance)")
    p = profile(db, e)
    if status_of(e) != "Received – ack pending":
        raise HTTPException(409, "Only instruments marked received can be acknowledged")
    on = _clean_date(b.get("on"), "Bank credit date") or today_ist()
    if on > today_ist() or (p.recv_on and on < p.recv_on):
        raise Bad("The bank credit date must be between the received date and today")
    bg = is_bg(p.type_key or "", p.mode)
    expect = dec(p.recv_amount if p.recv_amount is not None else e.amount)
    amt = dec(b.get("amount")) if b.get("amount") not in (None, "") else (expect if bg else None)
    if amt is None or amt < 0 or amt > expect:
        raise Bad(f"Amount credited must be between 0 and {inr(expect)}")
    ref = _txt(b.get("ref"), 100)
    if not bg and not ref:
        raise Bad("Enter the credit reference / UTR from the bank statement")
    short = q2(expect - amt)
    p.ack_on, p.ack_by, p.ack_ref, p.ack_amount, p.ack_account, p.ack_remarks = on, cu.id, ref, q2(amt), _txt(b.get("account"), 150), _txt(b.get("remarks"), 2000)
    p.ack_shortfall = short if short > 0 else None
    p.release_state, p.release_confirmed_by = "released", cu.id
    e.status, e.release_date, e.release_reference, e.updated_at = "Released", p.recv_on or on, ref or p.recv_ref, now_ist()
    e.return_status, e.return_confirmed_by, e.return_confirmed_at = "confirmed", cu.id, now_ist()
    _log(db, cu, request, e, "acknowledged", "Receipt acknowledged by Finance" + (f" – {ref}" if ref else "") + (f" · short by {inr(short)}" if short > 0 else ""),
         old={"status": "Received – ack pending"}, new={"status": "Released", "credited": float(amt), "shortfall": float(short) if short > 0 else None, "on": on.isoformat()})
    emit(db, e, "returned_released", cu)
    notify(db, _owners(db, e) + [p.recv_by, p.release_requested_by], "Instrument released",
           f"Finance acknowledged the receipt of {_label(e)}" + (f" – short by {inr(short)}" if short > 0 else "") + ".", e.id, "released")
    return {"shortfall": float(short) if short > 0 else 0}


# ─── validity extension & forfeiture ──────────────────────────────────────────

def _rule_exists(db: Session, cu: User, action: str, request: Optional[Request]) -> bool:
    """Is an approval rule configured for emdbg / <action>? Read in a separate, immediately closed session (the engine
    runs DDL on approval_rules from its own connection, which would wait on a metadata lock held by this transaction)."""
    from app.services.generic_approval_engine import _find_matching_approval_rule
    side = Session(bind=db.get_bind())
    try:
        rule, _ = _find_matching_approval_rule(side, tenant_id=_tenant_id(request), requester=side.get(User, cu.id), module_key=MODULE, action_key=action, request_group_id=None)
        return rule is not None
    except Exception as exc:
        logger.warning("approval rule lookup failed: %s", exc)
        return False
    finally:
        side.rollback()
        side.close()


def _apply_extension(db: Session, actor: Optional[User], e: EMDBG, new: date, reason: Optional[str], request: Optional[Request] = None) -> None:
    old = e.expiry_date
    db.add(EMDBGRenewalHistory(emdbg_id=e.id, old_expiry_date=old, new_expiry_date=new, old_reference=e.instrument_number, new_reference=e.instrument_number,
                               renewed_by=actor.id if actor else None, notes=f"Validity extended{f' – {reason}' if reason else ''}"))
    e.expiry_date, e.renewal_date, e.renewal_status, e.updated_at = new, today_ist(), "renewed", now_ist()
    p = profile(db, e)
    p.ext_new_date = p.ext_bank_ref = p.ext_approval_id = None
    p.reminded_for = p.reminded_days = p.expired_alert_at = None
    _log(db, actor, request, e, "extended", f"Validity extended {fdt(old)} → {fdt(new)}" + (f" – {reason}" if reason else ""),
         old={"validity": _iso(old)}, new={"validity": new.isoformat(), "reason": reason})


def extend(db: Session, cu: User, request: Request, e: EMDBG, new: date, reason: Optional[str]) -> dict[str, Any]:
    _need(user_has_permission(db, cu, "emdbg.update"), "extend validity")
    p = profile(db, e)
    if status_of(e) not in ("Active", "Release Requested") or p.type_key == "TF":
        raise HTTPException(409, "Only Active or Release Requested instruments can be extended")
    if not e.expiry_date:
        raise HTTPException(409, "This instrument has no validity date to extend")
    if p.ext_approval_id:
        raise HTTPException(409, "An extension is already waiting for approval")
    if new <= e.expiry_date:
        raise Bad(f"The new validity must be after {fdt(e.expiry_date)}")
    if new > today_ist() + timedelta(days=3650):
        raise Bad("The new validity is too far in the future")
    reason = _txt(reason, 500)
    if not reason:
        raise Bad("Give the reason for the extension")
    if _rule_exists(db, cu, "extend", request):
        from app.services.generic_approval_engine import create_generic_approval_request
        req = create_generic_approval_request(db, tenant_id=_tenant_id(request), requester=cu, module_key=MODULE, action_key="extend", record_id=e.id)
        if (req.status or "").strip().lower() != "approved":
            p.ext_new_date, p.ext_bank_ref, p.ext_approval_id = new, reason[:100], req.id
            _log(db, cu, request, e, "extension_requested", f"Extension to {fdt(new)} sent for approval – {reason}", new={"validity": new.isoformat(), "approval_request_id": req.id})
            return {"status": "pending", "message": f"Extension to {fdt(new)} sent for approval"}
    _apply_extension(db, cu, e, new, reason, request)
    return {"status": "extended", "message": f"Validity extended to {fdt(new)}"}


def forfeit(db: Session, cu: User, request: Request, e: EMDBG, b: dict[str, Any]) -> None:
    _need(user_has_permission(db, cu, "emdbg.approve"), "mark instruments forfeited")
    p = profile(db, e)
    if status_of(e) != "Active" or p.type_key == "TF":
        raise HTTPException(409, "Only Active instruments can be marked forfeited")
    on = _clean_date(b.get("on"), "Forfeiture date") or today_ist()
    if on > today_ist():
        raise Bad("The forfeiture date cannot be in the future")
    reason = _txt(b.get("reason"), 2000)
    if not reason or len(reason) < 4:
        raise Bad("Give the reason for the forfeiture")
    p.forfeit_on, p.forfeit_by, p.forfeit_reason = on, cu.id, reason
    e.status, e.updated_at = "Forfeited", now_ist()
    _log(db, cu, request, e, "forfeited", f"Marked forfeited on {fdt(on)} – {reason}", old={"status": "Active"},
         new={"status": "Forfeited", "amount": float(dec(e.amount)), "tender_id": e.tender_id, "wo_id": e.work_order_id, "remarks": _txt(b.get("remarks"), 2000)})
    emit(db, e, "forfeited", cu)
    notify(db, _owners(db, e) + finance_users(db), "Instrument forfeited", f"{_label(e)} was forfeited by the customer – {reason}.", e.id, "forfeited")


# ─── approval callback ────────────────────────────────────────────────────────

def on_decision(db: Session, request_row, actor: User, remarks: str = "") -> None:
    """Approval engine callback for emdbg / request(_50l), release_request and extend."""
    e = db.query(EMDBG).filter(EMDBG.id == request_row.record_id).first()
    if not e:
        return
    p = profile(db, e)
    status = (request_row.status or "").strip().lower()
    if request_row.action_key in ("request", "request_50l") and p.req_approval_id == request_row.id and e.status == "Pending approval":
        if status == "approved":
            _to_finance(db, actor, e, p)
        elif status == "rejected":
            e.status, e.approval_status, e.last_rejection_reason, e.updated_at = "Rejected", "rejected", remarks or None, now_ist()
            _log(db, actor, None, e, "rejected", f"Rejected by {actor.full_name}" + (f" – “{remarks}”" if remarks else ""), old={"status": "Pending approval"}, new={"status": "Rejected"})
            notify(db, _owners(db, e), "Request rejected", f"{_label(e)} was rejected" + (f": {remarks}" if remarks else "."), e.id, "request_rejected")
    elif request_row.action_key == "release_request" and p.release_approval_id == request_row.id and p.release_state == "pending_approval":
        if status == "approved" and status_of(e) == "Active":
            _set_release_requested(db, actor, None, e, p)
        elif status == "rejected":
            p.release_state = "rejected"
            _log(db, actor, None, e, "release_rejected", "Refund / release request rejected" + (f" – {remarks}" if remarks else ""), new={"remarks": remarks or None})
            notify(db, [p.release_requested_by], "Release request rejected", f"Release of {_label(e)} was rejected" + (f": {remarks}" if remarks else "."), e.id, "release_rejected")
    elif request_row.action_key == "extend" and p.ext_approval_id == request_row.id:
        if status == "approved" and p.ext_new_date:
            _apply_extension(db, actor, e, p.ext_new_date, p.ext_bank_ref)
        elif status == "rejected":
            new = p.ext_new_date
            p.ext_new_date = p.ext_bank_ref = p.ext_approval_id = None
            _log(db, actor, None, e, "extension_rejected", f"Extension to {fdt(new)} rejected" + (f" – {remarks}" if remarks else ""), new={"remarks": remarks or None})
            notify(db, [e.created_by], "Extension rejected", f"Extending {_label(e)} was rejected" + (f": {remarks}" if remarks else "."), e.id, "extension_rejected")


def record_label(db: Session, request_row) -> Optional[str]:
    e = db.query(EMDBG).filter(EMDBG.id == request_row.record_id).first()
    if not e:
        return None
    return f"{e.instrument_type} {inr(e.amount)} for {e.tender_num or e.po_number or '—'} · {(e.client_name or '')[:30]} ({e.reference_num})"


# ─── Bids & Tenders: auto-create EMD request ──────────────────────────────────

def on_tender_emd(db: Session, cu: User, t: Tender) -> Optional[EMDBG]:
    """Setting "Auto-create instrument when a bid needs EMD": one EMD request per tender (idempotent auto_key), sent for
    head approval like any request – created in a savepoint so a failure never blocks the tender."""
    try:
        ensure_schema(db)
        if not t.emd_amount or dec(t.emd_amount) <= 0 or not config(db)["auto_create"]:
            return None
        ak = f"tender:{t.id}:emd"
        if db.query(InstrumentProfile.emdbg_id).filter(InstrumentProfile.auto_key == ak).first() or \
                db.query(EMDBG.id).filter(EMDBG.tender_id == t.id, EMDBG.instrument_type == "EMD").first():
            return None
        dc = deposit_config(db, t)["emd"]
        sp = db.begin_nested()
        try:
            v = validate_request(db, cu, {"type": "EMD", "tender_id": t.id, "amount": t.emd_amount, "mode": dc["mode"],
                                          "due": dc["due"] if dc["due"] and dc["due"] >= today_ist().isoformat() else (today_ist() + timedelta(days=3)).isoformat(),
                                          "bene": dc["bene"] or t.customer_name or "Customer", "at": dc["at"], "remarks": f"Auto-created – tender {t.tender_num or t.id} needs EMD"})
            e, _ = create_request(db, cu, None, v, auto_key=ak)
            sp.commit()
            return e
        except Exception as exc:
            sp.rollback()
            logger.warning("EMD auto-create for tender %s skipped: %s", t.id, exc)
            return None
    except Exception as exc:
        logger.warning("EMD auto-create check failed: %s", exc)
        return None


# ─── background jobs: reminders, expiry, refund overdue, Finance waiting ──────

def expiry_reminders(db: Session) -> int:
    """EMD / BG expiring: reminders at the configured days, 15 and 7 days before validity (one per threshold)."""
    cfg = config(db)
    if not cfg["alert_expiring"]:
        return 0
    today = today_ist()
    marks = sorted({cfg["remind_days"], 15, 7}, reverse=True)
    rows = (db.query(EMDBG, InstrumentProfile).outerjoin(InstrumentProfile, InstrumentProfile.emdbg_id == EMDBG.id)
            .filter(EMDBG.status.in_(("Active", "Release Requested", "Renewed")), EMDBG.expiry_date.isnot(None), EMDBG.expiry_date >= today,
                    EMDBG.expiry_date <= today + timedelta(days=max(marks)))).all()
    fin = finance_users(db)
    n = 0
    for e, p in rows:
        p = p or profile(db, e)
        days = (e.expiry_date - today).days
        mark = min(m for m in marks if days <= m)
        if p.reminded_for == e.expiry_date and p.reminded_days is not None and p.reminded_days <= mark:
            continue
        notify(db, fin + _owners(db, e), "Instrument expiring", f"{_label(e)} expires {'today' if days == 0 else f'in {days} days'} – {fdt(e.expiry_date)}.", e.id, "expiry_reminder")
        p.reminded_for, p.reminded_days = e.expiry_date, mark
        _log(db, None, None, e, "expiry_reminder", f"Expiry reminder sent ({days} d before {fdt(e.expiry_date)})")
        n += 1
    db.commit()
    return n


def expired_alerts(db: Session) -> int:
    """Instrument expired: the day after expiry, then weekly while it stays unresolved."""
    if not config(db)["alert_expired"]:
        return 0
    today = today_ist()
    rows = (db.query(EMDBG, InstrumentProfile).outerjoin(InstrumentProfile, InstrumentProfile.emdbg_id == EMDBG.id)
            .filter(EMDBG.status.in_(("Active", "Release Requested", "Expired", "Renewed")), EMDBG.expiry_date.isnot(None), EMDBG.expiry_date < today)).all()
    fin = finance_users(db)
    n = 0
    for e, p in rows:
        p = p or profile(db, e)
        if p.expired_alert_at and (now_ist() - p.expired_alert_at).days < 7:
            continue
        notify(db, fin + _owners(db, e), "Instrument expired", f"{_label(e)} expired on {fdt(e.expiry_date)} – extend, claim the refund or get it released.", e.id, "expired")
        p.expired_alert_at = now_ist()
        n += 1
    db.commit()
    return n


def escalations(db: Session) -> int:
    """Refund not received: escalate after the configured days (Setup → Escalate unreleased after)."""
    cfg = config(db)
    if not cfg["alert_refund"]:
        return 0
    cutoff = now_ist() - timedelta(days=cfg["escalate_days"])
    rows = (db.query(EMDBG, InstrumentProfile).join(InstrumentProfile, InstrumentProfile.emdbg_id == EMDBG.id)
            .filter(EMDBG.status == "Release Requested", InstrumentProfile.release_requested_at.isnot(None), InstrumentProfile.release_requested_at <= cutoff,
                    or_(InstrumentProfile.escalated_at.is_(None), InstrumentProfile.escalated_at <= cutoff)).all())
    fin = finance_users(db)
    admins = [u.id for u in db.query(User.id).filter(User.is_active == True, User.role.in_(["admin", "ceo"])).all()]  # noqa: E712
    n = 0
    for e, p in rows:
        days = (now_ist() - p.release_requested_at).days
        p.escalated_at, p.escalation_count = now_ist(), (p.escalation_count or 0) + 1
        notify(db, fin + admins + [p.release_requested_by] + _owners(db, e), "Refund overdue", f"{_label(e)} has been awaiting refund / return for {days} days.", e.id, "refund_overdue")
        _log(db, None, None, e, "escalated", f"Escalated – refund not received for {days} days (escalation {p.escalation_count})")
        n += 1
    db.commit()
    return n


def finance_waiting(db: Session) -> int:
    """Approved request waiting for Finance when the required-by date is within 2 days (once a day)."""
    if not config(db)["alert_finance"]:
        return 0
    today = today_ist()
    rows = (db.query(EMDBG, InstrumentProfile).join(InstrumentProfile, InstrumentProfile.emdbg_id == EMDBG.id)
            .filter(EMDBG.status == "With Finance", InstrumentProfile.required_by.isnot(None), InstrumentProfile.required_by <= today + timedelta(days=2))).all()
    fin = finance_users(db)
    n = 0
    for e, p in rows:
        if p.fin_alert_on == today:
            continue
        d = (p.required_by - today).days
        notify(db, fin, "Finance payment pending", f"{_label(e)} is required {'today' if d == 0 else f'in {d} days' if d > 0 else f'{-d} days ago'} – still waiting for Finance.", e.id, "finance_pending")
        p.fin_alert_on = today
        n += 1
    db.commit()
    return n


def run_jobs_for_all_tenants() -> dict[str, dict[str, int]]:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    m = MasterSessionLocal()
    try:
        slugs = [t.slug for t in m.query(Tenant).all()]
    finally:
        m.close()
    out: dict[str, dict[str, int]] = {}
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
        except Exception:
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
            r = {"reminders": expiry_reminders(db), "expired": expired_alerts(db), "escalations": escalations(db), "finance": finance_waiting(db)}
            if any(r.values()):
                out[slug] = r
        except Exception as exc:
            db.rollback()
            logger.warning("instrument jobs for %s failed: %s", slug, exc)
        finally:
            db.close()
    return out


# ─── record drawer ────────────────────────────────────────────────────────────

def detail(db: Session, cu: User, e: EMDBG) -> dict[str, Any]:
    from app.models.all_models import ActivityLog, ApprovalRequest
    p = profile(db, e)
    db.commit()
    cfg = config(db)
    rows = [r for r in list_rows(db, cu) if r["id"] == e.id]
    r = rows[0]
    today = today_ist()
    tk = r["type_key"]
    sens = can(db, cu)["sensitive"]
    ids = {x for x in (e.created_by, p.approved_by, p.fin_by, p.recv_by, p.ack_by, p.forfeit_by, p.release_requested_by) if x}
    who = {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(ids)).all()} if ids else {}
    # approval chain of the head approval
    chain, apr = [], None
    if p.req_approval_id:
        apr = db.get(ApprovalRequest, p.req_approval_id)
        if apr:
            for s in sorted(apr.steps or [], key=lambda x: x.step_no):
                chain.append({"step": s.step_no, "role": (s.approver_role or "").replace("_", " ").title(), "user": getattr(getattr(s, "approver", None), "full_name", "") or "",
                              "state": (s.status or "pending").title(), "at": _iso(s.acted_at), "remarks": s.remarks or ""})
    t = db.query(Tender).filter(Tender.id == e.tender_id).first() if e.tender_id else None
    tender = None
    if t and not t.is_deleted:
        from app.services import bid_service
        trow = next((x for x in bid_service.list_rows(db, cu)[0] if x["id"] == t.id), None)
        tl = []
        add = lambda d, l, s="", c="inf": tl.append({"d": _iso(d), "l": l, "s": s, "c": c}) if d else None  # noqa: E731
        add(t.created_at.date() if getattr(t, "created_at", None) else None, "Tender created", f"{t.portal_ref_number or ''} · bid manager {trow['owner'] if trow else '—'}", "ac")
        add(getattr(t, "published_date", None), f"Published on {trow['portal'] if trow and trow['portal'] else 'portal'}", "", "mu")
        for x in db.query(EMDBG, InstrumentProfile).outerjoin(InstrumentProfile, InstrumentProfile.emdbg_id == EMDBG.id).filter(EMDBG.tender_id == t.id).all():
            ie, ip = x
            L = ie.instrument_type
            if status_of(ie) == "Exempted":
                add(ip.requested_on if ip else None, "EMD exemption recorded", ip.exempt_cert if ip else "", "mu")
                continue
            add((ip.requested_on if ip else None) or (ie.created_at.date() if ie.created_at else None), f"{L} requested", f"{inr(ie.amount)} · {(ip.mode if ip else '') or ''}", "wa")
            if ip:
                add(ip.approved_on.date() if ip.approved_on else None, f"{L} approved", "sent to Finance", "ok")
                add(ip.pay_date, f"{L} {'paid' if L == 'Tender fee' else 'paid / issued'}", f"UTR {ip.utr}" if ip.utr else (f"Ref {ie.instrument_number}" if ie.instrument_number else ""), "ok")
                add(ip.ret_on, f"{L} refund requested", "", "wa")
                add(ip.recv_on, f"{L} received back", inr(ip.recv_amount if ip.recv_amount is not None else ie.amount), "inf")
                add(ip.ack_on, f"Finance acknowledged {L} receipt", "", "ok")
        add(t.submission_date, "Bid submission deadline", "", "ba")
        tl.sort(key=lambda x: x["d"] or "")
        tender = {"id": t.id, "ref": r["tender"], "title": t.tender_title or "", "nit": t.portal_ref_number or "", "customer": t.customer_name or "",
                  "portal": trow["portal"] if trow else "", "value": float(t.est_value or 0), "stage": trow["stage"] if trow else "", "submit": _iso(t.submission_date),
                  "owner": trow["owner"] if trow else "", "timeline": tl}
    order = None
    if e.work_order_id:
        w = db.execute(text("SELECT id, wo_number, project_title, customer_name, po_number, po_value, wo_value, delivery_date FROM work_orders WHERE id = :i"),
                       {"i": e.work_order_id}).mappings().first()
        if w:
            order = {"id": w["id"], "ref": w["wo_number"], "work": w["project_title"] or "", "customer": w["customer_name"] or "", "po": w["po_number"] or "",
                     "value": float(w["wo_value"] or w["po_value"] or 0), "due": _iso(w["delivery_date"])}
    acts = db.query(ActivityLog).filter(ActivityLog.module == MODULE, ActivityLog.record_id == e.id).order_by(ActivityLog.id.desc()).limit(300).all()
    by = {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_({a.user_id for a in acts if a.user_id} or {-1})).all()}
    hist = db.query(EMDBGRenewalHistory).filter(EMDBGRenewalHistory.emdbg_id == e.id).order_by(EMDBGRenewalHistory.id.desc()).all()
    m = lambda v: float(q2(dec(v))) if v is not None else None  # noqa: E731
    st = r["status"]
    bgx = r["bg"] and tk != "TF"
    c = can(db, cu)
    mine = e.created_by == cu.id
    acts_ok = {
        "open_approval": st == "Pending approval" and bool(p.req_approval_id),
        "withdraw": st == "Pending approval" and (mine or c["update"]),
        "resubmit": st == "Rejected" and (mine or c["update"]) and not (p.exempt_cert),
        "pay": st == "With Finance" and c["finance"],
        "refund": st == "Active" and tk != "TF" and c["update"] and p.release_state != "pending_approval",
        "receive": st in ("Active", "Release Requested") and tk != "TF" and c["update"],
        "extend": st in ("Active", "Release Requested") and tk != "TF" and bool(e.expiry_date) and bgx and c["update"] and not p.ext_approval_id,
        "forfeit": st == "Active" and tk != "TF" and c["forfeit"],
        "acknowledge": st == "Received – ack pending" and c["finance"],
    }
    hide = (lambda v: v) if sens else (lambda v: "••••" if v not in (None, "", "—") else v)
    return {
        **r, "purpose": PURPOSE.get(tk, r["type"]), "bene": p.beneficiary or e.client_name, "at": p.payable_at or "", "bank": e.bank_name or "",
        "utr": hide(p.utr or ""), "ref": hide(e.instrument_number or "") if e.instrument_number != p.utr else "", "remarks": e.notes or "",
        "margin_pct": hide(float(p.margin_pct)) if p.margin_pct is not None and cfg["track_margin"] else None,
        "margin_amount": hide(m(p.margin_amount)) if p.margin_amount is not None and cfg["track_margin"] else None,
        "charges": hide(m(p.charges)) if p.charges is not None else None, "debit_account": hide(p.debit_account or ""), "exempt_cert": p.exempt_cert or "",
        "dates": {"recorded": r["requested"], "recorded_by": who.get(e.created_by, ""), "due": r["due"], "approved": _iso(p.approved_on.date()) if p.approved_on else None,
                  "approved_by": who.get(p.approved_by, "") or ("" if not p.approved_on else "Auto-approved"), "sent_to_finance": _iso(p.approved_on.date()) if p.approved_on else None,
                  "paid": _iso(p.pay_date), "paid_by": who.get(p.fin_by, ""), "validity": r["validity"], "refund_requested": r["ret_on"], "received": _iso(p.recv_on),
                  "received_by": who.get(p.recv_by, ""), "received_amount": m(p.recv_amount), "acknowledged": _iso(p.ack_on), "acknowledged_by": who.get(p.ack_by, ""),
                  "forfeited": _iso(p.forfeit_on), "forfeited_by": who.get(p.forfeit_by, "")},
        "receipt": {"mode": p.recv_mode or "", "ref": p.recv_ref or "", "remarks": p.recv_remarks or "", "ack_ref": hide(p.ack_ref or ""), "ack_amount": hide(m(p.ack_amount)),
                    "ack_account": hide(p.ack_account or ""), "shortfall": m(p.ack_shortfall), "ack_remarks": p.ack_remarks or ""},
        "refund": {"reason": p.release_reason or "", "letter": p.ret_letter or "", "pending_approval": p.release_state == "pending_approval"},
        "forfeit": {"reason": p.forfeit_reason or ""},
        "approval": {"id": p.req_approval_id, "status": (apr.status if apr else None), "chain": chain, "requested_by": who.get(e.created_by, ""),
                     "requested_at": _iso(apr.requested_at) if apr else None, "priority": p.priority or "", "rejection": e.last_rejection_reason or ""},
        "extension": {"pending_date": _iso(p.ext_new_date), "approval_request_id": p.ext_approval_id},
        "extensions": [{"old": _iso(h.old_expiry_date), "new": _iso(h.new_expiry_date), "notes": h.notes, "at": _iso(h.created_at)} for h in hist],
        "tender_rec": tender, "order_rec": order,
        "timeline": [{"t": a.description, "by": by.get(a.user_id, "System"), "d": a.created_at.isoformat() if a.created_at else None} for a in acts],
        "actions": acts_ok, "can": c, "form": {"amount": m(e.amount), "mode": p.mode, "due": _iso(p.required_by), "bene": p.beneficiary or "", "at": p.payable_at or "",
                                               "bank": e.bank_name or "", "remarks": e.notes or ""},
        "today": today.isoformat(),
    }
