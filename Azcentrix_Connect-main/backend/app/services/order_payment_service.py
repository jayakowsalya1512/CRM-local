"""Orders & Projects v18 · payment collection (order Payments tab + the "Collections & finance" segment).

Data (tenant DB, all additive):
* order_payment_plans   – Single payment | Stage-wise, one row per order.
* order_payment_stages  – the schedule: name, % of order value, due date, invoice / reference. The stage amount is
                          derived (pct × current order value, the last stage absorbs the rounding difference) so the
                          schedule always matches the order value.
* order_payment_receipts – customer receipts (shared with Field Sales 360 → Commitments). Sales records a receipt as
                          "Pending finance"; only Finance moves it to "Acknowledged" (after matching the bank credit)
                          or "Not credited". Only acknowledged money counts as received.
* order_receipt_history – every change to a receipt with before / after values (never edited or deleted).

Per stage (prototype pySt): received = acknowledged receipts, awaiting finance = pending receipts, balance =
max(0, amount − received − awaiting); status Received | Awaiting finance | Part paid | Part paid · overdue | Overdue |
Due soon (≤ 15 days) | Scheduled. "Not credited" receipts are ignored.

KPIs (prototype pyCollections): Order book = Σ order value · Due to date = Σ stage amounts due on or before today ·
Received = Σ acknowledged receipts · Awaiting finance = Σ pending receipts · Overdue = Σ balance of stages past due ·
Collection efficiency = round(Received ÷ Due to date × 100) (0 when nothing is due).

Permissions: viewing follows workorders.view + the workorders data scope; recording / correcting receipts and changing
the plan need workorders.update; acknowledging needs Finance (emdbg.approve or a finance role – the same rule as
Guarantees & Deposits).
"""
from __future__ import annotations

import logging
import threading
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.core.timezone import now_ist, today_ist
from app.dependencies import user_has_permission
from app.models.all_models import Quotation, Tender, User, WorkOrder
from app.models.commitments import OrderPaymentReceipt
from app.models.orders import PAYMENT_TABLES, OrderPaymentPlan, OrderPaymentStage, OrderReceiptHistory

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

PLANS = ("Single", "Stage-wise")
SINGLE_NAME = "Full payment on completion"
MODES = ["NEFT", "RTGS", "Cheque", "Demand draft", "Letter of credit", "Online / portal", "TDS adjustment"]
PENDING, ACK, NOT_CREDITED = "Pending finance", "Acknowledged", "Not credited"
# prototype PYPRE – "Start from" templates of the plan editor: (stage, %)
TEMPLATES: dict[str, list[tuple[str, int]]] = {
    "Single payment": [(SINGLE_NAME, 100)],
    "10 / 60 / 20 / 10": [("Advance against bank guarantee", 10), ("On supply / delivery", 60), ("On installation & commissioning", 20),
                          ("Retention – after defect liability", 10)],
    "30 / 60 / 10": [("Advance", 30), ("On delivery", 60), ("On commissioning", 10)],
    "80 / 10 / 10 (tender terms)": [("Against delivery", 80), ("On commissioning", 10), ("After warranty", 10)],
    "Monthly – 12 instalments": [(f"Month {i + 1}", 8 if i < 8 else 9) for i in range(12)],
}
DUE_SOON = 15
MAX_STAGES = 60
CENT = Decimal("0.01")
_RECEIPT_COLS = [("stage_id", "INT NULL"), ("entered_by", "INT NULL"), ("bank_ref", "VARCHAR(120) NULL"), ("credited_to", "VARCHAR(120) NULL"),
                 ("ack_remarks", "VARCHAR(500) NULL"), ("original_amount", "DECIMAL(15,2) NULL"), ("updated_at", "DATETIME NULL")]


def dec(v: Any) -> Decimal:
    try:
        return v if isinstance(v, Decimal) else Decimal(str(v if v is not None else 0))
    except Exception:
        return Decimal(0)


def q2(v: Decimal) -> Decimal:
    return v.quantize(CENT, rounding=ROUND_HALF_UP)


def iso(d: Any) -> Optional[str]:
    return d.isoformat() if d else None


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_receipt_schema(db: Session) -> None:
    """Receipts table (shared with Commitments) + its v18 columns + plans / stages / history. Idempotent."""
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        OrderPaymentReceipt.__table__.create(bind=bind, checkfirst=True)
        for col, ddl in _RECEIPT_COLS:
            try:
                db.execute(text(f"ALTER TABLE order_payment_receipts ADD COLUMN IF NOT EXISTS `{col}` {ddl}"))
            except Exception as exc:
                db.rollback()
                logger.warning("payments schema: order_payment_receipts.%s skipped: %s", col, exc)
        try:
            db.execute(text("CREATE INDEX IF NOT EXISTS ix_opr_stage ON order_payment_receipts (stage_id)"))
        except Exception as exc:
            db.rollback()
            logger.warning("payments schema: ix_opr_stage skipped: %s", exc)
        db.commit()
        for t in PAYMENT_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        _READY.add(slug)


# ─── helpers ──────────────────────────────────────────────────────────────────

def is_finance(db: Session, cu: User) -> bool:
    try:
        from app.services.instrument_service import is_finance as _fin
        return bool(_fin(db, cu))
    except Exception:
        db.rollback()
        return user_has_permission(db, cu, "emdbg.approve")


def can(db: Session, cu: User) -> dict[str, bool]:
    upd = user_has_permission(db, cu, "workorders.update")
    return {"record": upd, "plan": upd, "finance": is_finance(db, cu)}


def _names(db: Session, ids) -> dict[int, str]:
    ids = {int(i) for i in ids if i}
    return {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(ids)).all()} if ids else {}


def stage_amounts(value: Decimal, stages: list[OrderPaymentStage]) -> list[Decimal]:
    """pct × value per stage; the last stage takes the rounding difference so the schedule adds up to the order value."""
    if not stages:
        return []
    out = [q2(value * dec(s.pct) / 100) for s in stages]
    if sum((dec(s.pct) for s in stages), Decimal(0)) == 100:
        out[-1] = q2(value - sum(out[:-1], Decimal(0)))
    return out


def stage_state(amt: Decimal, due: Optional[date], rc: list[OrderPaymentReceipt], today: date) -> dict[str, Any]:
    live = [r for r in rc if r.status != NOT_CREDITED]
    ack = sum((dec(r.amount) for r in live if r.status == ACK), Decimal(0))
    pen = sum((dec(r.amount) for r in live if r.status == PENDING), Decimal(0))
    bal = max(Decimal(0), amt - ack - pen)
    od = bool(due and due < today)
    if ack >= amt:
        st = "Received"
    elif ack + pen >= amt:
        st = "Awaiting finance"
    elif ack + pen > 0:
        st = "Part paid · overdue" if od else "Part paid"
    elif od:
        st = "Overdue"
    elif due and (due - today).days <= DUE_SOON:
        st = "Due soon"
    else:
        st = "Scheduled"
    return {"ack": ack, "pen": pen, "bal": bal, "st": st, "overdue": od}


def _value(o: WorkOrder) -> Decimal:
    from app.services.order_service import value_of
    return value_of(o)


def _due(o: WorkOrder) -> Optional[date]:
    from app.services.order_service import due_of
    return due_of(o)


def ensure_plans(db: Session, orders: list[WorkOrder]) -> None:
    """Orders without a plan get the prototype default (pyEnsure): Single · "Full payment on completion" · 100 % · due on
    the order's due date. Receipts not linked to a stage yet (recorded before v18) are linked to the order's first stage.
    The plan row is inserted first with INSERT IGNORE, so two concurrent requests never create two default stages."""
    if not orders:
        return
    ids = [o.id for o in orders]
    have = {r[0] for r in db.query(OrderPaymentPlan.wo_id).filter(OrderPaymentPlan.wo_id.in_(ids)).all()}
    missing = [o for o in orders if o.id not in have]
    changed = False
    for o in missing:
        res = db.execute(text("INSERT IGNORE INTO order_payment_plans (wo_id, plan, created_at, updated_at) VALUES (:w, 'Single', :n, :n)"),
                         {"w": o.id, "n": now_ist()})
        if res.rowcount and not db.query(OrderPaymentStage.id).filter(OrderPaymentStage.wo_id == o.id).first():
            db.add(OrderPaymentStage(wo_id=o.id, position=0, name=SINGLE_NAME, pct=Decimal(100), due_date=_due(o)))
        changed = True
    if changed:
        db.flush()
    orphan_orders = {r[0] for r in db.query(OrderPaymentReceipt.wo_id).filter(OrderPaymentReceipt.wo_id.in_(ids), OrderPaymentReceipt.stage_id.is_(None)).distinct().all()}
    if orphan_orders:
        first = {}
        for s in db.query(OrderPaymentStage).filter(OrderPaymentStage.wo_id.in_(orphan_orders)).order_by(OrderPaymentStage.wo_id, OrderPaymentStage.position, OrderPaymentStage.id).all():
            first.setdefault(s.wo_id, s)
        for r in db.query(OrderPaymentReceipt).filter(OrderPaymentReceipt.wo_id.in_(orphan_orders), OrderPaymentReceipt.stage_id.is_(None)).all():
            s = first.get(r.wo_id)
            if s:
                r.stage_id = s.id
                _hist(db, r, "relinked", None, None, {"stage": s.name}, "Linked to the payment schedule (receipt recorded before stage-wise plans)")
        changed = True
    if changed:
        db.commit()


def _load(db: Session, orders: list[WorkOrder]) -> tuple[dict[int, str], dict[int, list[OrderPaymentStage]], dict[int, list[OrderPaymentReceipt]]]:
    ids = [o.id for o in orders] or [-1]
    plans = {p.wo_id: p.plan for p in db.query(OrderPaymentPlan).filter(OrderPaymentPlan.wo_id.in_(ids)).all()}
    stages: dict[int, list[OrderPaymentStage]] = {o.id: [] for o in orders}
    for s in db.query(OrderPaymentStage).filter(OrderPaymentStage.wo_id.in_(ids)).order_by(OrderPaymentStage.position, OrderPaymentStage.id).all():
        stages.setdefault(s.wo_id, []).append(s)
    rcpts: dict[int, list[OrderPaymentReceipt]] = {o.id: [] for o in orders}
    for r in db.query(OrderPaymentReceipt).filter(OrderPaymentReceipt.wo_id.in_(ids)).order_by(OrderPaymentReceipt.received_on.desc(), OrderPaymentReceipt.id.desc()).all():
        rcpts.setdefault(r.wo_id, []).append(r)
    return plans, stages, rcpts


def _refs(db: Session, orders: list[WorkOrder]) -> dict[int, dict[str, Any]]:
    """prototype pyRefH(): the tender the order came from (else its quote)."""
    tids = {o.tender_id for o in orders if o.tender_id}
    qids = {o.quotation_id for o in orders if o.quotation_id and not o.tender_id}
    T = {t.id: t for t in db.query(Tender.id, Tender.tender_num, Tender.tender_title).filter(Tender.id.in_(tids)).all()} if tids else {}
    Q = {q.id: q.quotation_number for q in db.query(Quotation.id, Quotation.quotation_number).filter(Quotation.id.in_(qids)).all()} if qids else {}
    out = {}
    for o in orders:
        t = T.get(o.tender_id) if o.tender_id else None
        if t:
            out[o.id] = {"kind": "tender", "id": t.id, "ref": t.tender_num or f"TND-{t.id}", "title": t.tender_title or ""}
        elif o.quotation_id and Q.get(o.quotation_id):
            out[o.id] = {"kind": "quote", "id": o.quotation_id, "ref": Q[o.quotation_id], "title": ""}
        else:
            out[o.id] = None
    return out


def _rc_json(r: OrderPaymentReceipt, stage_names: dict[int, str], nm: dict[int, str]) -> dict[str, Any]:
    return {"id": r.id, "wo_id": r.wo_id, "stage_id": r.stage_id, "stage": stage_names.get(r.stage_id or 0, ""), "amount": float(dec(r.amount)),
            "date": iso(r.received_on), "mode": r.mode or "", "ref": r.reference or "", "remarks": r.remarks or "",
            "by": nm.get(r.recorded_by or 0, ""), "by_id": r.recorded_by, "entered_by": nm.get(r.entered_by or 0, ""),
            "recorded_at": r.recorded_at.isoformat() if r.recorded_at else None, "status": r.status,
            "ack_by": nm.get(r.acknowledged_by or 0, ""), "ack_at": r.acknowledged_at.isoformat() if r.acknowledged_at else None,
            "bank_date": iso(r.bank_date), "bank_ref": r.bank_ref or "", "credited_to": r.credited_to or "", "ack_remarks": r.ack_remarks or "",
            "original_amount": float(dec(r.original_amount)) if r.original_amount is not None else None}


def receipt_totals(db: Session, ids: list[int]) -> dict[int, dict[str, Any]]:
    """Received (acknowledged) and awaiting finance (pending) per order – for the order grid columns."""
    out: dict[int, dict[str, Any]] = {}
    if not ids:
        return out
    for wo_id, st, amt, n in db.query(OrderPaymentReceipt.wo_id, OrderPaymentReceipt.status, func.sum(OrderPaymentReceipt.amount), func.count(OrderPaymentReceipt.id)) \
            .filter(OrderPaymentReceipt.wo_id.in_(ids), OrderPaymentReceipt.status.in_((ACK, PENDING))).group_by(OrderPaymentReceipt.wo_id, OrderPaymentReceipt.status).all():
        d = out.setdefault(wo_id, {"received": 0.0, "awaiting": 0.0, "pending_count": 0})
        if st == ACK:
            d["received"] = float(dec(amt))
        else:
            d["awaiting"], d["pending_count"] = float(dec(amt)), int(n)
    return out


# ─── read models ──────────────────────────────────────────────────────────────

def _schedule(o: WorkOrder, stages: list[OrderPaymentStage], rc: list[OrderPaymentReceipt], today: date) -> list[dict[str, Any]]:
    amts = stage_amounts(_value(o), stages)
    by_stage: dict[int, list[OrderPaymentReceipt]] = {}
    for r in rc:
        by_stage.setdefault(r.stage_id or 0, []).append(r)
    out = []
    for s, a in zip(stages, amts):
        x = stage_state(a, s.due_date, by_stage.get(s.id, []), today)
        out.append({"id": s.id, "name": s.name, "pct": float(dec(s.pct)), "amount": float(a), "due": iso(s.due_date), "invoice_ref": s.invoice_ref or "",
                    "received": float(x["ack"]), "awaiting": float(x["pen"]), "balance": float(x["bal"]), "status": x["st"], "overdue": x["overdue"],
                    "receipts": sum(1 for r in by_stage.get(s.id, []) if r.status != NOT_CREDITED)})
    return out


def payments(db: Session, cu: User, wo: WorkOrder) -> dict[str, Any]:
    """Order drawer → Payments tab (prototype pyTab)."""
    ensure_plans(db, [wo])
    plans, stages, rcpts = _load(db, [wo])
    today = today_ist()
    sch = _schedule(wo, stages[wo.id], rcpts[wo.id], today)
    value = _value(wo)
    ack = sum((dec(r.amount) for r in rcpts[wo.id] if r.status == ACK), Decimal(0))
    pen = sum((dec(r.amount) for r in rcpts[wo.id] if r.status == PENDING), Decimal(0))
    due = sum((dec(s["amount"]) for s in sch if s["due"] and s["due"] <= today.isoformat()), Decimal(0))
    ovd = sum((dec(s["balance"]) for s in sch if s["overdue"]), Decimal(0))
    nm = _names(db, [r.recorded_by for r in rcpts[wo.id]] + [r.acknowledged_by for r in rcpts[wo.id]] + [r.entered_by for r in rcpts[wo.id]])
    sn = {s.id: s.name for s in stages[wo.id]}
    pct = lambda a, b: int((a / b * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP)) if b > 0 else 0  # noqa: E731
    from app.models.orders import OrderProfile
    start = db.query(OrderProfile.start_date).filter(OrderProfile.wo_id == wo.id).scalar()
    return {
        "order": {"id": wo.id, "ref": wo.wo_number, "customer": wo.customer_name, "value": float(value), "start": iso(start),
                  "due": iso(_due(wo)), "collected_by": wo.project_manager_id},
        "plan": plans.get(wo.id, "Single"), "against": _refs(db, [wo])[wo.id],
        "totals": {"value": float(value), "due": float(due), "received": float(ack), "awaiting": float(pen), "outstanding": float(max(Decimal(0), value - ack - pen)),
                   "overdue": float(ovd), "received_pct": pct(ack, value), "with_awaiting_pct": pct(ack + pen, value)},
        "stages": sch, "receipts": [_rc_json(r, sn, nm) for r in rcpts[wo.id]],
        "modes": MODES, "templates": {k: [[n, p] for n, p in v] for k, v in TEMPLATES.items()}, "can": can(db, cu),
        "accounts": accounts(db),
    }


def accounts(db: Session) -> list[str]:
    """"Credited to" suggestions: the accounts Finance has used before (no hard-coded bank accounts)."""
    return [r[0] for r in db.query(OrderPaymentReceipt.credited_to).filter(OrderPaymentReceipt.credited_to.isnot(None), OrderPaymentReceipt.credited_to != "")
            .group_by(OrderPaymentReceipt.credited_to).order_by(func.count().desc()).limit(20).all()]


def collections(db: Session, cu: User) -> dict[str, Any]:
    """Orders & Projects → Collections & finance (prototype pyCollections): KPI strip, Finance acknowledgement queue,
    payment schedule of all accessible orders, all receipts."""
    from app.services.order_service import order_query
    orders = order_query(db, cu).order_by(WorkOrder.id.desc()).all()
    ensure_plans(db, orders)
    plans, stages, rcpts = _load(db, orders)
    refs = _refs(db, orders)
    today = today_ist()
    from app.services.quote_service import tenant_info
    try:
        company = tenant_info(db)["name"] or ""
    except Exception:
        company = ""
    allr = [r for o in orders for r in rcpts[o.id]]
    nm = _names(db, [r.recorded_by for r in allr] + [r.acknowledged_by for r in allr] + [r.entered_by for r in allr])
    sched, rows_r, queue = [], [], []
    book = due = ack = pen = ovd = Decimal(0)
    n_ovd = 0
    for o in orders:
        value = _value(o)
        book += value
        ref = refs[o.id]
        base = {"wo_id": o.id, "order": o.wo_number, "customer": o.customer_name or "", "company": company,
                "tender": ref["ref"] if ref else "", "tender_kind": ref["kind"] if ref else None, "tender_id": ref["id"] if ref else None}
        sn = {s.id: s.name for s in stages[o.id]}
        for s in _schedule(o, stages[o.id], rcpts[o.id], today):
            if s["due"] and s["due"] <= today.isoformat():
                due += dec(s["amount"])
            if s["overdue"] and s["balance"] > 0:
                ovd += dec(s["balance"])
                n_ovd += 1
            sched.append({**base, "id": f"{o.id}-{s['id']}", "plan": plans.get(o.id, "Single"), "stage_id": s["id"], "stage": s["name"], "pct": s["pct"],
                          "amount": s["amount"], "due": s["due"], "received": s["received"], "awaiting": s["awaiting"], "balance": s["balance"],
                          "status": s["status"], "invoice_ref": s["invoice_ref"]})
        for r in rcpts[o.id]:
            j = {**base, **_rc_json(r, sn, nm)}
            rows_r.append(j)
            if r.status == ACK:
                ack += dec(r.amount)
            elif r.status == PENDING:
                pen += dec(r.amount)
                queue.append(j)
    queue.sort(key=lambda x: (x["date"] or "", x["id"]))
    rows_r.sort(key=lambda x: (x["date"] or "", x["id"]), reverse=True)
    eff = int((ack / due * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP)) if due > 0 else 0
    return {
        "kpis": {"order_book": float(book), "due": float(due), "received": float(ack), "awaiting": float(pen), "awaiting_count": len(queue),
                 "overdue": float(ovd), "overdue_count": n_ovd, "efficiency": eff},
        "queue": queue, "schedule": sched, "receipts": rows_r, "can": can(db, cu), "modes": MODES, "accounts": accounts(db), "company": company,
        "orders": len(orders),
    }


# ─── history / audit ──────────────────────────────────────────────────────────

def _snap(r: OrderPaymentReceipt) -> dict[str, Any]:
    return {"stage_id": r.stage_id, "amount": float(dec(r.amount)), "received_on": iso(r.received_on), "mode": r.mode, "reference": r.reference,
            "collected_by": r.recorded_by, "remarks": r.remarks, "status": r.status}


def _hist(db: Session, r: OrderPaymentReceipt, action: str, cu: Optional[User], old: Optional[dict], new: Optional[dict], note: str = "") -> None:
    db.add(OrderReceiptHistory(receipt_id=r.id, wo_id=r.wo_id, action=action, actor_id=cu.id if cu else None, at=now_ist(), old=old, new=new,
                               note=(note or None) and note[:500]))


def history(db: Session, wo: WorkOrder, rid: int) -> list[dict[str, Any]]:
    r = _receipt(db, wo, rid, lock=False)
    rows = db.query(OrderReceiptHistory).filter(OrderReceiptHistory.receipt_id == r.id).order_by(OrderReceiptHistory.at, OrderReceiptHistory.id).all()
    nm = _names(db, [h.actor_id for h in rows])
    return [{"id": h.id, "action": h.action, "by": nm.get(h.actor_id or 0, "System"), "at": h.at.isoformat() if h.at else None,
             "old": h.old, "new": h.new, "note": h.note or ""} for h in rows]


def _log(db: Session, cu: User, request: Optional[Request], wo: WorkOrder, action: str, desc: str, old: Optional[dict] = None, new: Optional[dict] = None) -> None:
    from app.services.order_service import _log as order_log
    order_log(db, cu, request, wo, action, desc, old=old, new=new)


def _notify(db: Session, uid: Optional[int], title: str, msg: str, wo: WorkOrder, action: str) -> None:
    from app.services.order_service import notify
    notify(db, uid, title, msg, wo.id, action)


def _inr(v: Decimal) -> str:
    return f"₹{float(v):,.0f}"


# ─── validation ───────────────────────────────────────────────────────────────

def _lock(db: Session, wo: WorkOrder) -> None:
    db.execute(text("SELECT id FROM work_orders WHERE id = :i FOR UPDATE"), {"i": wo.id})


def _date(v: Any, label: str, *, required: bool = False, not_future: bool = False) -> Optional[date]:
    if v in (None, ""):
        if required:
            raise HTTPException(422, f"Enter the {label}")
        return None
    try:
        d = v if isinstance(v, date) else date.fromisoformat(str(v)[:10])
    except ValueError:
        raise HTTPException(422, f"Enter a valid {label}")
    if d.year < 2000 or d > today_ist() + timedelta(days=3650):
        raise HTTPException(422, f"The {label} is out of range")
    if not_future and d > today_ist():
        raise HTTPException(422, f"The {label} cannot be in the future")
    return d


def _amount(v: Any, label: str) -> Decimal:
    a = dec(v)
    if a <= 0:
        raise HTTPException(422, f"Enter the {label}")
    if a > Decimal("9999999999999.99"):
        raise HTTPException(422, f"The {label} is too large")
    return q2(a)


def _stage(db: Session, wo: WorkOrder, sid: Any) -> OrderPaymentStage:
    s = db.query(OrderPaymentStage).filter(OrderPaymentStage.id == int(sid or 0), OrderPaymentStage.wo_id == wo.id).first() if sid else None
    if not s:
        raise HTTPException(422, "Choose the payment stage this receipt is against")
    return s


def _user(db: Session, uid: Any) -> int:
    u = db.query(User.id).filter(User.id == int(uid or 0), User.is_active == True).first()  # noqa: E712
    if not u:
        raise HTTPException(422, "Choose an active user as “Collected by”")
    return u.id


def _receipt(db: Session, wo: WorkOrder, rid: int, lock: bool = True) -> OrderPaymentReceipt:
    q = db.query(OrderPaymentReceipt).filter(OrderPaymentReceipt.id == rid, OrderPaymentReceipt.wo_id == wo.id)
    r = (q.with_for_update() if lock else q).first()
    if not r:
        raise HTTPException(404, "Receipt not found")
    return r


def _receipt_fields(db: Session, wo: WorkOrder, body: dict[str, Any], cu: User) -> dict[str, Any]:
    ref = str(body.get("reference") or "").strip()
    if not ref:
        raise HTTPException(422, "Enter the UTR or cheque reference")
    if len(ref) > 120:
        raise HTTPException(422, "The reference can have at most 120 characters")
    mode = str(body.get("mode") or "").strip()
    if mode not in MODES:
        raise HTTPException(422, "Choose the payment mode")
    remarks = str(body.get("remarks") or "").strip()
    if len(remarks) > 500:
        raise HTTPException(422, "Remarks can have at most 500 characters")
    return {"stage": _stage(db, wo, body.get("stage_id")), "amount": _amount(body.get("amount"), "amount received"),
            "received_on": _date(body.get("received_on"), "received date", required=True, not_future=True), "mode": mode, "reference": ref,
            "collected_by": _user(db, body.get("collected_by") or cu.id), "remarks": remarks or None}


def _dup_ref(db: Session, wo: WorkOrder, ref: str, exclude: Optional[int] = None) -> None:
    q = db.query(OrderPaymentReceipt.id).filter(OrderPaymentReceipt.wo_id == wo.id, func.lower(OrderPaymentReceipt.reference) == ref.lower(),
                                                OrderPaymentReceipt.status != NOT_CREDITED)
    if exclude:
        q = q.filter(OrderPaymentReceipt.id != exclude)
    if q.first():
        raise HTTPException(409, {"message": f"A receipt with reference {ref} is already recorded for {wo.wo_number}", "field": "reference"})


# ─── payment plan ─────────────────────────────────────────────────────────────

def save_plan(db: Session, cu: User, request: Optional[Request], wo: WorkOrder, plan: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """prototype pyPlanOk(): Single (one stage, 100 %) or Stage-wise; percentages must add up to exactly 100 %. Stages
    kept by id keep their receipts and invoice reference; receipts of a removed stage move to the plan's first stage
    (recorded in each receipt's history) – no recorded payment is dropped."""
    if plan not in PLANS:
        raise HTTPException(422, "Choose Single payment or Stage-wise")
    if not rows:
        raise HTTPException(422, "Add at least one payment stage")
    if len(rows) > MAX_STAGES:
        raise HTTPException(422, f"A plan can have at most {MAX_STAGES} stages")
    if plan == "Single" and len(rows) != 1:
        raise HTTPException(422, "A single-payment plan has exactly one stage")
    _lock(db, wo)
    ensure_plans(db, [wo])
    cur = {s.id: s for s in db.query(OrderPaymentStage).filter(OrderPaymentStage.wo_id == wo.id).all()}
    clean, seen = [], set()
    for i, r in enumerate(rows, start=1):
        name = str(r.get("name") or "").strip()
        if not name:
            raise HTTPException(422, f"Name stage {i}")
        if len(name) > 200:
            raise HTTPException(422, f"Stage {i}: the name can have at most 200 characters")
        if name.lower() in seen:
            raise HTTPException(422, f"Stage “{name}” appears twice")
        seen.add(name.lower())
        pct = dec(r.get("pct"))
        if pct <= 0 or pct > 100:
            raise HTTPException(422, f"Stage “{name}”: the percentage must be more than 0 and at most 100")
        if pct != pct.quantize(CENT):
            raise HTTPException(422, f"Stage “{name}”: use at most two decimals for the percentage")
        due = _date(r.get("due"), f"due date of “{name}”", required=True)
        inv = str(r.get("invoice_ref") or "").strip()
        if len(inv) > 120:
            raise HTTPException(422, f"Stage “{name}”: the invoice / reference can have at most 120 characters")
        sid = int(r["id"]) if r.get("id") else None
        if sid and sid not in cur:
            raise HTTPException(422, f"Stage “{name}” does not belong to this order – reload and try again")
        clean.append({"id": sid, "name": name, "pct": q2(pct), "due": due, "invoice_ref": inv or None})
    tot = sum((c["pct"] for c in clean), Decimal(0))
    if tot != 100:
        raise HTTPException(422, f"Stage percentages must add up to 100% (now {float(tot):g}%)")
    if plan == "Single" and clean[0]["pct"] != 100:
        raise HTTPException(422, "A single payment is 100% of the order value")
    old_plan = db.query(OrderPaymentPlan).filter(OrderPaymentPlan.wo_id == wo.id).first()
    before = {"plan": old_plan.plan if old_plan else None,
              "stages": [{"name": s.name, "pct": float(dec(s.pct)), "due": iso(s.due_date), "invoice_ref": s.invoice_ref} for s in sorted(cur.values(), key=lambda x: (x.position, x.id))]}
    kept: list[OrderPaymentStage] = []
    for i, c in enumerate(clean):
        s = cur.get(c["id"]) if c["id"] else None
        if s is None:
            s = OrderPaymentStage(wo_id=wo.id, created_by=cu.id)
            db.add(s)
        s.position, s.name, s.pct, s.due_date, s.invoice_ref = i, c["name"], c["pct"], c["due"], c["invoice_ref"]
        kept.append(s)
    db.flush()
    keep_ids = {s.id for s in kept}
    removed = [s for sid, s in cur.items() if sid not in keep_ids]
    moved = 0
    for s in removed:
        for r in db.query(OrderPaymentReceipt).filter(OrderPaymentReceipt.stage_id == s.id).with_for_update().all():
            r.stage_id, r.updated_at = kept[0].id, now_ist()
            _hist(db, r, "relinked", cu, {"stage": s.name}, {"stage": kept[0].name}, f"Payment plan changed – stage “{s.name}” was removed")
            moved += 1
        db.delete(s)
    if old_plan:
        old_plan.plan, old_plan.updated_by = plan, cu.id
    else:
        db.add(OrderPaymentPlan(wo_id=wo.id, plan=plan, updated_by=cu.id))
    after = {"plan": plan, "stages": [{"name": c["name"], "pct": float(c["pct"]), "due": iso(c["due"]), "invoice_ref": c["invoice_ref"]} for c in clean]}
    what = "single payment" if plan == "Single" else f"{len(clean)} stages"
    _log(db, cu, request, wo, "payment_plan", f"Payment plan changed to {what}" + (f" – {moved} receipt{'s' if moved != 1 else ''} moved to “{kept[0].name}”" if moved else ""),
         old=before, new=after)
    db.commit()
    return {"ok": True, "moved": moved}


# ─── receipts ─────────────────────────────────────────────────────────────────

def record_receipt(db: Session, cu: User, request: Optional[Request], wo: WorkOrder, body: dict[str, Any]) -> dict[str, Any]:
    """prototype pyRecOk(): saved as Pending finance – never acknowledged by the person recording it."""
    _lock(db, wo)
    ensure_plans(db, [wo])
    v = _receipt_fields(db, wo, body, cu)
    _dup_ref(db, wo, v["reference"])
    r = OrderPaymentReceipt(wo_id=wo.id, stage_id=v["stage"].id, amount=v["amount"], received_on=v["received_on"], mode=v["mode"], reference=v["reference"],
                            remarks=v["remarks"], recorded_by=v["collected_by"], entered_by=cu.id, status=PENDING, recorded_at=now_ist(), updated_at=now_ist())
    db.add(r)
    db.flush()
    _hist(db, r, "recorded", cu, None, _snap(r), "Recorded – awaiting Finance acknowledgement")
    _log(db, cu, request, wo, "payment", f"Payment {_inr(v['amount'])} recorded against “{v['stage'].name}” – awaiting finance", new={"receipt": r.id, **_snap(r)})
    try:
        from app.services.instrument_service import finance_users
        for uid in set(finance_users(db)) - {cu.id}:
            _notify(db, uid, "Customer payment to acknowledge", f"{cu.full_name} recorded {_inr(v['amount'])} from {wo.customer_name} against {wo.wo_number} – "
                    "acknowledge after matching the bank credit", wo, "receipt_pending")
    except Exception as exc:
        logger.warning("receipt finance notification skipped: %s", exc)
    db.commit()
    return {"id": r.id, "status": r.status}


def correct_receipt(db: Session, cu: User, request: Optional[Request], wo: WorkOrder, rid: int, body: dict[str, Any]) -> dict[str, Any]:
    """Correction by Sales while the receipt is not acknowledged. A "Not credited" receipt that is corrected goes back
    to Finance as Pending finance. Acknowledged receipts are locked – the history keeps every earlier version."""
    _lock(db, wo)
    r = _receipt(db, wo, rid)
    if r.status == ACK:
        raise HTTPException(409, "This receipt is acknowledged by Finance and can no longer be changed")
    v = _receipt_fields(db, wo, body, cu)
    _dup_ref(db, wo, v["reference"], exclude=r.id)
    old = _snap(r)
    resubmit = r.status == NOT_CREDITED
    r.stage_id, r.amount, r.received_on, r.mode, r.reference, r.recorded_by, r.remarks = (v["stage"].id, v["amount"], v["received_on"], v["mode"], v["reference"],
                                                                                         v["collected_by"], v["remarks"])
    if resubmit:
        r.status, r.acknowledged_by, r.acknowledged_at, r.bank_date, r.bank_ref, r.credited_to, r.credited_amount = PENDING, None, None, None, None, None, None
    r.updated_at = now_ist()
    new = _snap(r)
    diff = {k for k in new if old[k] != new[k]}
    if not diff:
        db.rollback()
        return {"id": r.id, "status": r.status, "changed": False}
    note = "Corrected and sent back to Finance" if resubmit else "Corrected before Finance acknowledgement"
    _hist(db, r, "corrected", cu, {k: old[k] for k in diff}, {k: new[k] for k in diff}, note)
    _log(db, cu, request, wo, "payment", f"Receipt of {_inr(r.amount)} corrected ({', '.join(sorted(diff))})", old={k: old[k] for k in diff}, new={k: new[k] for k in diff})
    if resubmit:
        try:
            from app.services.instrument_service import finance_users
            for uid in set(finance_users(db)) - {cu.id}:
                _notify(db, uid, "Customer payment to acknowledge", f"{cu.full_name} corrected a receipt of {_inr(r.amount)} for {wo.wo_number} – please check again", wo, "receipt_pending")
        except Exception as exc:
            logger.warning("receipt finance notification skipped: %s", exc)
    db.commit()
    return {"id": r.id, "status": r.status, "changed": True}


def acknowledge(db: Session, cu: User, request: Optional[Request], wo: WorkOrder, rid: int, body: dict[str, Any], credited: bool = True) -> dict[str, Any]:
    """prototype pyAckOk() / pyNo(): Finance confirms the bank credit (Acknowledged) or reports it missing (Not credited)."""
    if not is_finance(db, cu):
        raise HTTPException(403, "Only Finance can acknowledge customer payments")
    _lock(db, wo)
    r = _receipt(db, wo, rid)
    if r.status != PENDING:
        raise HTTPException(409, f"This receipt is already {r.status.lower()}")
    old = {**_snap(r), "bank_date": None, "credited_amount": None}
    remarks = str(body.get("remarks") or "").strip()
    if len(remarks) > 500:
        raise HTTPException(422, "Remarks can have at most 500 characters")
    now = now_ist()
    if credited:
        bd = _date(body.get("bank_date"), "bank credit date", not_future=True) or r.received_on
        bref = str(body.get("bank_ref") or "").strip() or r.reference
        acct = str(body.get("credited_to") or "").strip()
        if len(bref) > 120 or len(acct) > 120:
            raise HTTPException(422, "The bank reference and account can have at most 120 characters")
        ca = _amount(body.get("credited_amount"), "amount credited") if body.get("credited_amount") not in (None, "") else dec(r.amount)
        if ca > dec(r.amount):
            raise HTTPException(422, f"The amount credited cannot be more than the {_inr(dec(r.amount))} recorded – ask Sales to correct the receipt first")
        r.status, r.bank_date, r.bank_ref, r.credited_to, r.credited_amount = ACK, bd, bref, acct or None, ca
        if ca != dec(r.amount):
            r.original_amount, r.amount = r.amount, ca
    else:
        if not remarks:
            raise HTTPException(422, "Say why the payment was not credited")
        r.status = NOT_CREDITED
    r.acknowledged_by, r.acknowledged_at, r.ack_remarks, r.updated_at = cu.id, now, remarks or None, now
    new = {**_snap(r), "bank_date": iso(r.bank_date), "bank_ref": r.bank_ref, "credited_to": r.credited_to,
           "credited_amount": float(dec(r.credited_amount)) if r.credited_amount is not None else None}
    _hist(db, r, "acknowledged" if credited else "not_credited", cu, old, new, remarks)
    if credited:
        _log(db, cu, request, wo, "payment_ack", f"Finance acknowledged {_inr(r.amount)}" + (f" (recorded {_inr(dec(r.original_amount))})" if r.original_amount is not None else ""),
             old={"status": PENDING}, new=new)
    else:
        _log(db, cu, request, wo, "payment_ack", f"Payment {_inr(r.amount)} marked not credited by Finance", old={"status": PENDING}, new=new)
    for uid in {r.recorded_by, r.entered_by} - {None, cu.id}:
        _notify(db, uid, "Payment acknowledged by Finance" if credited else "Payment not credited",
                f"{cu.full_name} " + (f"acknowledged {_inr(r.amount)} from {wo.customer_name} ({wo.wo_number})" if credited
                                      else f"could not find {_inr(r.amount)} against {wo.wo_number} in the bank – please check with the customer"), wo,
                "receipt_ack" if credited else "receipt_rejected")
    db.commit()
    return {"id": r.id, "status": r.status}


# ─── shared ledger for every module that shows collections ───────────────────

def ledger(db: Session, wo_ids) -> dict[str, Any]:
    """One definition of collections for Customer 360, dashboards, analytics, reports and Field Sales 360 – the same
    stages and receipts the Collections & finance tab shows:

    * collected   = Finance-acknowledged receipts, dated by the bank credit date (else the received date)
    * awaiting    = receipts recorded by Sales, not yet acknowledged
    * receivable  = unpaid balance of payment stages due on or before today (awaiting-finance money is not unpaid)
    * days_overdue = days since the stage due date, for receivable ageing
    The caller passes order ids it is allowed to see (its own data scope)."""
    ids = sorted({int(i) for i in (wo_ids or []) if i})
    empty = {"stages": [], "receipts": [], "orders": {}}
    if not ids:
        return empty
    try:
        ensure_receipt_schema(db)
        orders = db.query(WorkOrder).filter(WorkOrder.id.in_(ids)).all()
        ensure_plans(db, orders)
        _, stages, rcpts = _load(db, orders)
    except Exception as exc:
        db.rollback()
        logger.warning("payment ledger unavailable: %s", exc)
        return empty
    today = today_ist()
    allr = [r for o in orders for r in rcpts[o.id]]
    nm = _names(db, [r.recorded_by for r in allr] + [r.acknowledged_by for r in allr])
    st_rows, rc_rows, per = [], [], {}
    for o in orders:
        base = {"wo_id": o.id, "order": o.wo_number, "customer": o.customer_name or "", "customer_id": o.customer_id}
        sch = _schedule(o, stages[o.id], rcpts[o.id], today)
        due_of_stage = {s["id"]: s["due"] for s in sch}
        name_of_stage = {s["id"]: s["name"] for s in sch}
        agg = {"value": float(_value(o)), "due": 0.0, "received": 0.0, "awaiting": 0.0, "receivable": 0.0, "overdue": 0.0}
        for s in sch:
            due_now = bool(s["due"] and s["due"] <= today.isoformat())
            rec = s["balance"] if due_now else 0.0
            od = (today - date.fromisoformat(s["due"])).days if s["overdue"] and s["balance"] > 0 else 0
            agg["due"] += s["amount"] if due_now else 0.0
            agg["receivable"] += rec
            agg["overdue"] += s["balance"] if s["overdue"] else 0.0
            st_rows.append({**base, "id": f"{o.id}-{s['id']}", "stage_id": s["id"], "stage": s["name"], "pct": s["pct"], "amount": s["amount"], "due": s["due"],
                            "received": s["received"], "awaiting": s["awaiting"], "balance": s["balance"], "receivable": rec, "days_overdue": od, "status": s["status"]})
        for r in rcpts[o.id]:
            amt = float(dec(r.amount))
            if r.status == ACK:
                agg["received"] += amt
            elif r.status == PENDING:
                agg["awaiting"] += amt
            rc_rows.append({**base, "id": r.id, "amount": amt, "received_on": iso(r.received_on), "credited_on": iso(r.bank_date or r.received_on),
                            "status": r.status, "mode": r.mode or "", "ref": r.reference or "", "by": nm.get(r.recorded_by or 0, ""),
                            "ack_by": nm.get(r.acknowledged_by or 0, ""), "ack_at": r.acknowledged_at.isoformat() if r.acknowledged_at else None,
                            "stage": name_of_stage.get(r.stage_id or 0, ""), "stage_due": due_of_stage.get(r.stage_id or 0)})
        per[o.id] = agg
    return {"stages": st_rows, "receipts": rc_rows, "orders": per}


# ─── used by Field Sales 360 → Commitments ────────────────────────────────────

def next_balance(db: Session, orders: list[WorkOrder]) -> dict[int, dict[str, Any]]:
    """First payment stage of each order that still has a balance (pending receipts count against it)."""
    ensure_plans(db, orders)
    _, stages, rcpts = _load(db, orders)
    today = today_ist()
    out = {}
    for o in orders:
        for s in _schedule(o, stages[o.id], rcpts[o.id], today):
            if s["balance"] > 0:
                out[o.id] = {"stage_id": s["id"], "milestone_id": None, "title": s["name"], "balance": s["balance"], "due": s["due"]}
                break
    return out
