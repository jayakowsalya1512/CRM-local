"""Guarantees & Deposits (prototype v18 · Finance & Field → Guarantees & Deposits)   /api/v1/instruments

Header (Finance & field crumb · N instruments · New request), alerts, Total outstanding (stacked distribution +
legend) with six KPI cards, views Register | Awaiting approval | Finance desk | Expiry & alerts | By tender, the
New guarantee / deposit request modal, the instrument drawer and every lifecycle action:
withdraw · revise & resubmit · Finance pay / issue · refund / release request · mark received back · Finance
acknowledge · extend validity · mark forfeited. Head approval, release approval and extension approval use the
Approvals engine (module "emdbg").

Permissions: emdbg.view / create / update / approve / export (Finance = emdbg.approve or a configured Finance role),
settings.manage for Setup → Guarantees & deposits. The company is the tenant (tenant database per company); the
legacy EMD/BG data scope applies on top. The legacy /api/v1/emdbg API is unchanged.
"""
from __future__ import annotations

import csv
import io
import json
from datetime import date
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.services import instrument_service as S

router = APIRouter()
VIEWS = ["Register", "Awaiting approval", "Finance desk", "Expiry & alerts", "By tender"]
# prototype v18 gdCols: ID | [Company] | Instrument | Tender / order | Customer | Mode | Amount | Recorded | Required by | Approved | UTR / instrument | Valid until | Status | Next step
COLUMNS = ["code", "type", "tender", "customer", "mode", "amount", "requested", "due", "approved_on", "utr", "validity", "eff_status", "next"]
NUMERIC = {"amount"}


def ins_user(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "emdbg.view"):
        raise HTTPException(403, "You do not have access to Guarantees & Deposits")
    S.ensure_schema(db)
    return cu


@router.get("/meta")
def meta(request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    from app.services.quote_service import tenant_info
    try:
        company = tenant_info(db)["name"]
    except Exception:
        company = None
    cfg = S.config(db)
    t = getattr(request.state, "tenant", None)
    return {"company": company, "companies": [{"id": str(getattr(t, "slug", "") or "company"), "name": company or "Company"}], "views": VIEWS,
            "statuses": S.STATUSES, "tones": S.TONE, "types": [x for x in S.types(db) if x["key"] in {k for k, *_ in S.DEFAULT_TYPES} and x["active"]],
            "modes": S.MODES, "exempt_mode": S.EXEMPT, "ret_reasons": S.RET_REASONS, "recv_modes": S.RECV_MODES, "banks": cfg["banks"], "accounts": cfg["accounts"],
            "config": cfg, "preferred_banks": S.PREFERRED_BANKS, "high_value": float(S.HIGH_VALUE), "me": {"id": cu.id, "name": cu.full_name}, "can": S.can(db, cu)}


# ─── register / summary ───────────────────────────────────────────────────────

def _t(r: dict, k: str) -> str:
    v = r.get(k)
    return "" if v is None else str(v)


def _cond(r: dict, k: str, op: str, v: str) -> bool:
    t, tl, vl = _t(r, k), _t(r, k).lower(), (v or "").lower()
    try:
        n, vn = float(r.get(k) or 0), float(v)
    except (TypeError, ValueError):
        n = vn = None
    return {"contains": vl in tl, "ncontains": vl not in tl, "eq": tl == vl or (n is not None and n == vn), "ne": not (tl == vl or (n is not None and n == vn)),
            "starts": tl.startswith(vl), "gt": n is not None and n > vn, "lt": n is not None and n < vn, "gte": n is not None and n >= vn,
            "lte": n is not None and n <= vn, "empty": t.strip() in ("", "—"), "nempty": t.strip() not in ("", "—")}.get(op, True)


def _in_view(r: dict, view: str) -> bool:
    if view == "Awaiting approval":
        return r["status"] == "Pending approval"
    return True


def _filter(rows: list[dict], view: str, type_key: str, status: str, validity: str, link: str, q: str, f: str, adv: str) -> list[dict]:
    try:
        quick, advf = (json.loads(f) if f else {}), (json.loads(adv) if adv else {})
    except ValueError:
        raise HTTPException(422, "Invalid filter")
    sel = [r for r in rows if _in_view(r, view)]
    if type_key:
        sel = [r for r in sel if r["type_key"] == type_key]
    if status:
        sel = [r for r in sel if r["eff_status"] == status or r["status"] == status]
    if validity == "expired":
        sel = [r for r in sel if r["expired"]]
    elif validity in ("15", "30", "60"):
        sel = [r for r in sel if r["status"] in ("Active", "Release Requested") and r["days"] is not None and 0 <= r["days"] <= int(validity)]
    elif validity == "none":
        sel = [r for r in sel if not r["validity"]]
    if link:
        ll = link.lower()
        sel = [r for r in sel if ll in f"{r['tender']} {r['tender_no']} {r['wo']}".lower()]
    if q.strip():
        ql = q.strip().lower()
        sel = [r for r in sel if any(ql in _t(r, k).lower() for k in COLUMNS + ["tender_no", "wo", "bank"])]
    for k, v in (quick or {}).items():
        if k in COLUMNS and str(v or "").strip():
            sel = [r for r in sel if str(v).lower() in _t(r, k).lower()]
    conds = [c for c in (advf.get("conds") or []) if isinstance(c, dict) and c.get("k") in COLUMNS]
    if conds:
        test = all if advf.get("logic") != "OR" else any
        sel = [r for r in sel if test(_cond(r, c["k"], str(c.get("op") or "contains"), str(c.get("v") or "")) for c in conds)]
    return sel


@router.get("/list")
def list_instruments(view: str = "Register", type: str = "", status: str = "", validity: str = "", link: str = "", q: str = "", f: str = "", adv: str = "",
                     sorts: str = "", offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=1000),
                     db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    rows = S.list_rows(db, cu)
    sel = _filter(rows, view, type, status, validity, link, q, f, adv)
    try:
        order = json.loads(sorts) if sorts else []
    except ValueError:
        raise HTTPException(422, "Invalid sort")
    items = [x for x in order if isinstance(x, (list, tuple)) and len(x) == 2 and x[0] in COLUMNS]
    if not items:
        sel.sort(key=lambda r: (r["requested"] or "", r["id"]), reverse=True)
    for k, d in reversed(items):
        sel.sort(key=lambda r: (r[k] if r[k] is not None else -1e18) if k in NUMERIC else _t(r, k).lower(), reverse=int(d) < 0)
    return {"items": sel[offset:offset + limit], "total": len(sel), "total_all": len(rows), "summary": S.summary(rows)}


@router.get("/summary")
def summary(db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    rows = S.list_rows(db, cu)
    today = date.today()
    fin_pay = [r for r in rows if r["status"] == "With Finance"]
    fin_ack = [r for r in rows if r["status"] == "Received – ack pending"]
    exp = [r for r in rows if r["expired"]] + sorted([r for r in rows if r["status"] in ("Active", "Release Requested") and not r["expired"] and r["days"] is not None and r["days"] <= 60],
                                                      key=lambda r: r["validity"])
    refunds = [r for r in rows if r["status"] == "Release Requested"]
    collections = 0      # Orders & Projects has no customer-collection receipts awaiting Finance yet – the note stays hidden
    return {"summary": S.summary(rows), "finance_pay": fin_pay, "finance_ack": fin_ack, "expiring": exp, "refunds": refunds, "collections_pending": collections,
            "today": today.isoformat()}


@router.get("/by-tender")
def by_tender(db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    return {"items": S.by_tender(db, cu)}


@router.get("/export")
def export(view: str = "Register", type: str = "", status: str = "", validity: str = "", link: str = "", q: str = "",
           db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    if not user_has_permission(db, cu, "emdbg.export"):
        raise HTTPException(403, "You do not have permission to export financial records")
    sel = _filter(S.list_rows(db, cu), view, type, status, validity, link, q, "", "")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["ID", "Instrument", "Tender / order", "Customer", "Mode", "Amount", "Recorded", "Required by", "Approved", "UTR / instrument", "Valid until", "Status", "Next step"])
    for r in sel:
        w.writerow([r["code"], r["type"], r["tender"] or r["wo"], r["customer"], r["mode"], f"{r['amount']:.2f}", r["requested"] or "", r["due"] or "", r["approved_on"] or "",
                    r["utr"], r["validity"] or "", r["eff_status"], r["next"]])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="guarantees-deposits.csv"'})


# ─── New request ──────────────────────────────────────────────────────────────

@router.get("/options")
def options(q: str = "", db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    return {"tenders": S.tender_options(db, cu, q), "orders": S.order_options(db, cu)}


@router.get("/defaults")
def defaults(type: str, tender_id: Optional[int] = None, wo_id: Optional[int] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    return S.defaults(db, cu, tender_id, wo_id, type)


class RequestIn(BaseModel):
    tender_id: Optional[int] = None
    wo_id: Optional[int] = None
    type: str = Field(..., max_length=10)
    amount: Optional[float] = None
    mode: str = Field(..., max_length=60)
    due: Optional[date] = None
    bene: Optional[str] = Field(None, max_length=200)
    at: Optional[str] = Field(None, max_length=200)
    bank: Optional[str] = Field(None, max_length=100)
    remarks: Optional[str] = Field(None, max_length=2000)
    cert: Optional[str] = Field(None, max_length=150)
    allow_duplicate: bool = False


@router.post("", status_code=201)
def create(body: RequestIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    if not user_has_permission(db, cu, "emdbg.create"):
        raise HTTPException(403, "You do not have permission to create requests")
    v = S.validate_request(db, cu, body.model_dump())
    e, msg = S.create_request(db, cu, request, v)
    db.commit()
    return {"id": e.id, "code": e.reference_num, "status": e.status, "message": msg}


# ─── settings (Setup → Sales modules → Guarantees & deposits) ─────────────────

class SettingsIn(BaseModel):
    remind_days: Optional[int] = None
    track_margin: Optional[bool] = None
    release_approval: Optional[bool] = None
    auto_create: Optional[bool] = None
    preferred_bank: Optional[str] = None
    escalate_days: Optional[int] = None
    track_fdr: Optional[bool] = None
    banks: Optional[list[str]] = None
    accounts: Optional[list[str]] = None
    finance_roles: Optional[list[str]] = None
    alert_expiring: Optional[bool] = None
    alert_expired: Optional[bool] = None
    alert_refund: Optional[bool] = None
    alert_received: Optional[bool] = None
    alert_finance: Optional[bool] = None
    alert_email: Optional[bool] = None


@router.get("/config/settings")
def get_settings(db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    return {**S.config(db), "preferred_banks": S.PREFERRED_BANKS, "can_configure": user_has_permission(db, cu, "settings.manage")}


@router.put("/config/settings")
def put_settings(body: SettingsIn, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    if not user_has_permission(db, cu, "settings.manage"):
        raise HTTPException(403, "You do not have permission to change Guarantees & deposits settings")
    return S.save_config(db, cu, body.model_dump(exclude_none=True))


# ─── instrument ───────────────────────────────────────────────────────────────

@router.get("/{iid}")
def get_detail(iid: int, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    return S.detail(db, cu, S.get_instrument(db, cu, iid))


def _act(db: Session, cu: User, iid: int):
    return S.get_instrument(db, cu, iid, lock=True)


@router.post("/{iid}/withdraw")
def withdraw(iid: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    S.withdraw(db, cu, request, _act(db, cu, iid))
    db.commit()
    return {"ok": True, "message": "Request withdrawn – the approval is cancelled"}


class ResubmitIn(BaseModel):
    amount: Optional[float] = None
    mode: Optional[str] = Field(None, max_length=60)
    due: Optional[date] = None
    bene: Optional[str] = Field(None, max_length=200)
    at: Optional[str] = Field(None, max_length=200)
    bank: Optional[str] = Field(None, max_length=100)
    remarks: Optional[str] = Field(None, max_length=2000)


@router.post("/{iid}/resubmit")
def resubmit(iid: int, body: ResubmitIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    e = _act(db, cu, iid)
    if e.created_by != cu.id and not user_has_permission(db, cu, "emdbg.update"):
        raise HTTPException(403, "Only the requester can revise this request")
    msg = S.resubmit(db, cu, request, e, body.model_dump(exclude_unset=True))
    db.commit()
    return {"ok": True, "message": msg}


class PayIn(BaseModel):
    pay_date: Optional[date] = None
    utr: Optional[str] = Field(None, max_length=100)
    ref: Optional[str] = Field(None, max_length=100)
    txn_ref: Optional[str] = Field(None, max_length=100)
    account: Optional[str] = Field(None, max_length=150)
    bank: Optional[str] = Field(None, max_length=100)
    validity: Optional[date] = None
    margin_pct: Optional[float] = None
    margin_amount: Optional[float] = None
    charges: Optional[float] = None
    remarks: Optional[str] = Field(None, max_length=2000)


@router.post("/{iid}/pay")
def pay(iid: int, body: PayIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    S.pay(db, cu, request, _act(db, cu, iid), body.model_dump())
    db.commit()
    return {"ok": True}


class RefundIn(BaseModel):
    on: Optional[date] = None
    letter: Optional[str] = Field(None, max_length=100)
    reason: str = Field(..., max_length=100)


@router.post("/{iid}/refund-request")
def refund_request(iid: int, body: RefundIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    if not user_has_permission(db, cu, "emdbg.update"):
        raise HTTPException(403, "You do not have permission to request a refund / release")
    res = S.request_refund(db, cu, request, _act(db, cu, iid), body.model_dump())
    db.commit()
    return res


class ReceiveIn(BaseModel):
    on: Optional[date] = None
    amount: Optional[float] = None
    mode: Optional[str] = Field(None, max_length=60)
    ref: Optional[str] = Field(None, max_length=150)
    remarks: Optional[str] = Field(None, max_length=2000)


@router.post("/{iid}/receive")
def receive(iid: int, body: ReceiveIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    S.receive(db, cu, request, _act(db, cu, iid), body.model_dump())
    db.commit()
    return {"ok": True}


class AckIn(BaseModel):
    on: Optional[date] = None
    ref: Optional[str] = Field(None, max_length=100)
    amount: Optional[float] = None
    account: Optional[str] = Field(None, max_length=150)
    remarks: Optional[str] = Field(None, max_length=2000)


@router.post("/{iid}/acknowledge")
def acknowledge(iid: int, body: AckIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    res = S.acknowledge(db, cu, request, _act(db, cu, iid), body.model_dump())
    db.commit()
    return {"ok": True, **res}


class ExtendIn(BaseModel):
    validity: date
    reason: str = Field(..., max_length=500)


@router.post("/{iid}/extend")
def extend(iid: int, body: ExtendIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    res = S.extend(db, cu, request, _act(db, cu, iid), body.validity, body.reason)
    db.commit()
    return res


class ForfeitIn(BaseModel):
    on: Optional[date] = None
    reason: str = Field(..., max_length=2000)
    remarks: Optional[str] = Field(None, max_length=2000)


@router.post("/{iid}/forfeit")
def forfeit(iid: int, body: ForfeitIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(ins_user)):
    S.forfeit(db, cu, request, _act(db, cu, iid), body.model_dump())
    db.commit()
    return {"ok": True}
