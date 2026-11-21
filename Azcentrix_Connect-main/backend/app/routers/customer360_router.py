"""Customers & Contacts (prototype v17) – list with saved views, Customer 360 and its tabs.  /api/v1/customer360

Create / edit / delete / status / KAM changes go through the existing customer endpoints' own functions
(customer_router), so duplicate checks, approvals, KAM assignment history, notifications and audit logging
behave exactly as elsewhere.  Every customer read applies the role's customer Data Visibility.
"""
from __future__ import annotations

import csv
import io
import json
import logging
from datetime import datetime
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field, field_validator
from app.core import validators as V
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.validators import detail_text
from app.core.logging import log_audit_db
from app.core.timezone import now_ist
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import Customer, CustomerContact, User
from app.models.customer360 import BUYING_ROLES, HIERARCHY_LEVELS, KAM_MODES, CustomerContactRole, CustomerProfile
from app.services import customer360_detail as D
from app.services import customer360_service as S

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Customers & Contacts"])

# Prototype v17 customer grid (final): ID | Company | Customer | Main customer | Level | Parent entity | Type | Vertical | Value band |
# Segment | Sub-segment | City | KAM | Tier | FY revenue | Health | Status | (row actions)
COLUMNS = ("ref", "company", "name", "root", "level", "parent", "type", "vertical", "band", "segment", "sub_segment", "city", "kam", "tier", "revenue", "health", "status")
VIEWS = ("All", "My accounts", "Tier A", "At risk")


# ─── access ───────────────────────────────────────────────────────────────────

def c360_user(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "customers.view"):
        raise HTTPException(403, "You don't have access to Customers")
    S.ensure_schema(db)
    return cu


def _need(db: Session, cu: User, key: str, what: str) -> None:
    if not user_has_permission(db, cu, key):
        raise HTTPException(403, f"You don't have permission to {what}")


def scoped_customers(db: Session, cu: User) -> list[Customer]:
    from app.routers.customer_router import _apply_customer_data_scope
    return _apply_customer_data_scope(db, db.query(Customer), cu).filter(Customer.is_deleted == False).all()


def get_customer(db: Session, cu: User, cid: int) -> Customer:
    from app.routers.customer_router import _apply_customer_data_scope
    c = _apply_customer_data_scope(db, db.query(Customer), cu).filter(Customer.id == cid, Customer.is_deleted == False).first()
    if not c:
        raise HTTPException(404, "Customer not found")
    return c


def all_customers(db: Session) -> list[Customer]:
    """Every live customer – the comparison base for value bands and peer averages (figures only, no record access)."""
    return db.query(Customer).filter(Customer.is_deleted == False).all()


# ─── meta ─────────────────────────────────────────────────────────────────────

def company_name(db: Session) -> Optional[str]:
    """The workspace (tenant) company the customers belong to – the grid's Company column."""
    try:
        from app.database import MasterSessionLocal
        from app.models.tenant import Tenant
        m = MasterSessionLocal()
        try:
            t = m.query(Tenant).filter(Tenant.slug == db.info.get("tenant_slug")).first()
            return t.name if t else None
        finally:
            m.close()
    except Exception:
        return None


@router.get("/meta")
def meta(request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    # Type = the form's Customer Segment value: its master options plus any value already in use.
    types = sorted(set(S.Segments(db).options(db)) | {(r[0] or "").strip() for r in db.query(Customer.customer_vertical).distinct().all() if r[0] and r[0].strip()})
    company = company_name(db)
    users = db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()
    return {
        "company": company, "views": list(VIEWS), "statuses": list(S.STATUSES), "tiers": ["A", "B", "C"], "types": types,
        "users": [{"id": u.id, "name": u.full_name} for u in users], "me": {"id": cu.id, "name": cu.full_name},
        "levels": list(HIERARCHY_LEVELS), "kam_modes": list(KAM_MODES), "buying_roles": list(BUYING_ROLES),
        "can": {k: user_has_permission(db, cu, f"customers.{k}") for k in ("create", "update", "delete", "export")},
    }


# ─── customer form (prototype formPage) ───────────────────────────────────────

INDIAN_STATES = ["Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana", "Himachal Pradesh",
                 "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha",
                 "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
                 "Andaman and Nicobar Islands", "Chandigarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir",
                 "Ladakh", "Lakshadweep", "Puducherry"]


def _approval_preview(db: Session, cu: User, request: Request, action: str) -> Optional[dict[str, Any]]:
    """Whether saving would wait for approval, and for whom – the same rule lookup the save itself uses."""
    try:
        from app.routers.customer_router import _get_tenant_id
        from app.services.generic_approval_engine import find_matching_approval_rule, is_top_level_auto_approval_requester
        if is_top_level_auto_approval_requester(db, cu):
            return None
        rule = find_matching_approval_rule(db, tenant_id=_get_tenant_id(request), requester=cu, module_key="customers", action_key=action)
        if not rule:
            return None
        names = S.user_names(db, [st.approver_user_id for st in (rule.steps or [])])
        chain = [names.get(st.approver_user_id) or (st.approver_role or st.approver_type or "approver").replace("_", " ").title()
                 for st in sorted(rule.steps or [], key=lambda x: x.step_no)]
        return {"chain": chain}
    except Exception as exc:
        logger.info("Approval preview unavailable: %s", exc)
        db.rollback()
        return None


@router.get("/form-meta")
def form_meta(request: Request, customer_id: Optional[int] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    customers = scoped_customers(db, cu)
    P = S.profiles(db)
    profile = None
    if customer_id:
        c = get_customer(db, cu, customer_id)
        p = P.get(c.id)
        profile = {"level": S.level_of(c, P), "kam_mode": (p.kam_mode if p and p.kam_mode else "Own KAM")}
    return {
        "customers": sorted(({"id": c.id, "name": c.customer_name, "level": S.level_of(c, P)} for c in customers if c.id != customer_id), key=lambda x: x["name"].casefold()),
        "types": sorted(set(S.Segments(db).options(db)) | {(r[0] or "").strip() for r in db.query(Customer.customer_vertical).distinct().all() if r[0] and r[0].strip()}),
        "industries": sorted({(r[0] or "").strip() for r in db.query(Customer.industry).distinct().all() if r[0] and r[0].strip()}),
        "groups": sorted({(r[0] or "").strip() for r in db.query(Customer.group_name).distinct().all() if r[0] and r[0].strip()}),
        "divisions": sorted({(r[0] or "").strip() for r in db.query(Customer.division).distinct().all() if r[0] and r[0].strip()}),
        "states": INDIAN_STATES, "statuses": list(S.STATUSES), "levels": list(HIERARCHY_LEVELS), "kam_modes": list(KAM_MODES),
        "users": [{"id": u.id, "name": u.full_name} for u in db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()],
        "approval": {"create": _approval_preview(db, cu, request, "create"), "update": _approval_preview(db, cu, request, "update")},
        "profile": profile,
    }


# ─── list ─────────────────────────────────────────────────────────────────────

def _rows(db: Session, cu: User) -> list[dict[str, Any]]:
    customers = scoped_customers(db, cu)
    M = S.account_metrics(db)
    fam = S.Family(db)
    P = S.profiles(db)
    bands = S.value_bands(all_customers(db), M)
    kams = {c.id: fam.kam(c.id, P) for c in customers}
    names = S.user_names(db, [k[0] for k in kams.values()])
    company = company_name(db) or ""
    out = []
    for c in customers:
        m = S.metrics_for(M, c.id)
        k = kams[c.id]
        path = fam.path(c.id)
        parent = fam.parent(c.id)
        level = S.level_of(c, P)
        segment, sub_segment = S.segment_of(c)
        out.append({
            "id": c.id, "ref": S.cust_ref(c.id), "company": company, "name": c.customer_name,
            "root": fam.by_id[path[0]].customer_name if len(path) > 1 else "", "root_id": path[0] if len(path) > 1 else None,
            "level": level, "badge": S.LEVEL_BADGE.get(level, ("•", "l5")), "depth": len(path) - 1, "below": len(fam.desc(c.id)),
            "parent": fam.by_id[parent].customer_name if parent else "", "parent_id": parent,
            "type": (c.customer_vertical or "").strip(), "vertical": S.vertical_of(c), "band": bands.get(c.id, "Maintain"),
            "segment": segment, "sub_segment": sub_segment,
            "tree": [fam.by_id[i].customer_name.casefold() for i in path],
            "city": c.billing_city or "", "kam": names.get(k[0], "") if k[0] else "", "kam_id": k[0], "kam_own": k[1],
            "tier": S.TIER_OF.get(c.account_potential or "Medium", "B"), "revenue": round(m["fy"], 2), "health": m["health"],
            "status": c.account_status or "Prospect", "pending": (c.approval_status or "") == "pending",
        })
    return out


def _view(r: dict, view: str, me: int) -> bool:
    return {"My accounts": r["kam_id"] == me, "Tier A": r["tier"] == "A", "At risk": r["health"] < 55}.get(view, True)


def _txt(r: dict, k: str) -> str:
    v = r.get(k)
    return "" if v is None else str(v)


def _cond(r: dict, k: str, op: str, v: str) -> bool:
    t, tl, vl = _txt(r, k), _txt(r, k).lower(), (v or "").lower()
    try:
        n, vn = float(r.get(k) or 0), float(v)
    except (TypeError, ValueError):
        n = vn = None
    if op == "contains": return vl in tl
    if op == "ncontains": return vl not in tl
    if op == "eq": return tl == vl or (n is not None and n == vn)
    if op == "ne": return not (tl == vl or (n is not None and n == vn))
    if op == "starts": return tl.startswith(vl)
    if op in ("gt", "lt", "gte", "lte"):
        if n is None: return False
        return {"gt": n > vn, "lt": n < vn, "gte": n >= vn, "lte": n <= vn}[op]
    if op == "empty": return t.strip() in ("", "—")
    if op == "nempty": return t.strip() not in ("", "—")
    if op == "before": return t < v
    if op == "after": return t > v
    return True


@router.get("/list")
def list_customers(
    view: str = "All", q: str = "", status: str = "", f: str = "", adv: str = "", sorts: str = "",
    offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=250),
    db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user),
):
    try:
        quick = json.loads(f) if f else {}
        advf = json.loads(adv) if adv else {}
        order = json.loads(sorts) if sorts else []
    except ValueError:
        raise HTTPException(422, "Invalid filter or sort")
    rows = _rows(db, cu)
    counts = {v: sum(1 for r in rows if _view(r, v, cu.id)) for v in VIEWS}
    sel = [r for r in rows if _view(r, view, cu.id)]
    if status:
        sel = [r for r in sel if r["status"] == status]
    if q.strip():
        ql = q.strip().lower()
        sel = [r for r in sel if any(ql in _txt(r, k).lower() for k in COLUMNS)]
    for k, v in (quick or {}).items():
        if k in COLUMNS and str(v or "").strip():
            sel = [r for r in sel if str(v).lower() in _txt(r, k).lower()]
    conds = [c for c in (advf.get("conds") or []) if isinstance(c, dict) and c.get("k") in COLUMNS]
    if conds:
        test = all if advf.get("logic") != "OR" else any
        sel = [r for r in sel if test(_cond(r, c["k"], str(c.get("op") or "contains"), str(c.get("v") or "")) for c in conds)]
    for k, d in reversed([x for x in order if isinstance(x, (list, tuple)) and len(x) == 2 and x[0] in COLUMNS]):
        num = k in ("revenue", "health")
        sel.sort(key=lambda r: (r[k] or 0) if num else (r["id"] if k == "ref" else _txt(r, k).lower()), reverse=int(d) < 0)
    if not order:   # prototype order: each group's main customer followed by the entities below it
        sel.sort(key=lambda r: r["tree"])
    page = [{k: v for k, v in r.items() if k != "tree"} for r in sel[offset:offset + limit]]
    return {"items": page, "total": len(sel), "total_all": len(rows), "counts": counts}


# ─── inline edit & bulk (through the existing customer endpoints) ─────────────

class FieldIn(BaseModel):
    field: Literal["type", "city", "kam", "tier", "status", "level"]
    value: Optional[str] = None


def _apply_field(db: Session, cu: User, request: Request, c: Customer, field: str, value: Optional[str]) -> None:
    from app.routers.customer_router import CustomerCreate, change_status, update_customer
    v = (value or "").strip()
    if field == "level":
        if v not in HIERARCHY_LEVELS:
            raise HTTPException(422, f"Level must be one of {', '.join(HIERARCHY_LEVELS)}")
        p = _profile(db, c.id)
        old = p.hierarchy_level
        p.hierarchy_level = v
        log_audit_db(db, cu.id, "customers", "hierarchy", c.id, get_request_ip(request), f"Hierarchy level: {old or 'not set'} → {v}",
                     old_data={"level": old}, new_data={"level": v}, record_name=c.customer_name)
        db.commit()
        return
    if field == "status":
        if v not in S.STATUSES:
            raise HTTPException(422, f"Status must be one of {', '.join(S.STATUSES)}")
        change_status(c.id, request, status=v, db=db, current_user=cu)
        return
    if field == "tier":
        if v not in S.POTENTIAL_OF:
            raise HTTPException(422, "Tier must be A, B or C")
        payload = {"account_potential": S.POTENTIAL_OF[v]}
    elif field == "kam":
        if not v:
            payload = {"assigned_to": None}
        else:
            uid = int(v) if v.isdigit() else None
            u = db.query(User).filter(User.is_active == True, (User.id == uid) if uid else (User.full_name == v)).first()
            if not u:
                raise HTTPException(422, "Choose an active user as KAM")
            payload = {"assigned_to": u.id}
    elif field == "type":
        payload = {"customer_vertical": v or None}
    else:
        try:
            v = V.check_text(v, "City", 2, 100) or ""
        except ValueError as e:
            raise V.field_error("value", str(e))
        payload = {"billing_city": v or None}
    update_customer(c.id, CustomerCreate(customer_name=c.customer_name, **payload), request, db=db, current_user=cu)


@router.patch("/{customer_id}/field")
def edit_field(customer_id: int, body: FieldIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    _need(db, cu, "customers.update", "edit customers")
    c = get_customer(db, cu, customer_id)
    _apply_field(db, cu, request, c, body.field, body.value)
    row = next((r for r in _rows(db, cu) if r["id"] == customer_id), None)
    return row or {"id": customer_id}


class BulkIn(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)
    action: Literal["reassign", "delete", "status", "tier"]
    value: Optional[str] = None


@router.post("/bulk")
def bulk(body: BulkIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    from app.routers.customer_router import delete_customer
    _need(db, cu, "customers.delete" if body.action == "delete" else "customers.update", "delete customers" if body.action == "delete" else "edit customers")
    done, failed = 0, []
    for cid in dict.fromkeys(body.ids):
        try:
            c = get_customer(db, cu, cid)
            if body.action == "delete":
                delete_customer(cid, request, db=db, current_user=cu)
            else:
                _apply_field(db, cu, request, c, {"reassign": "kam", "status": "status", "tier": "tier"}[body.action], body.value)
            done += 1
        except HTTPException as exc:
            db.rollback()
            failed.append({"id": cid, "error": detail_text(exc.detail, "Not allowed")})
    return {"done": done, "failed": failed}


# ─── import (prototype "Import" button) ───────────────────────────────────────

IMPORT_COLUMNS = ["Customer", "Type", "Sub-segment", "City", "State", "GST", "Status", "Tier", "KAM email", "Contact name", "Contact designation", "Contact department", "Contact phone", "Contact email"]


@router.get("/import/template")
def import_template(cu: User = Depends(c360_user)):
    from fastapi.responses import Response
    return Response(",".join(IMPORT_COLUMNS) + "\n", media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="customers-import-template.csv"'})


@router.post("/import")
async def import_customers(request: Request, file: UploadFile = File(...), db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    from app.routers.customer_router import ContactCreate, CustomerCreate, create_customer
    _need(db, cu, "customers.create", "create customers")
    raw = await file.read()
    if len(raw) > 2_000_000:
        raise HTTPException(413, "The file is larger than 2 MB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "Customer" not in [h.strip() for h in reader.fieldnames]:
        raise HTTPException(422, "The CSV needs a 'Customer' column – download the template")
    created, errors = 0, []
    users = {(u.email or "").lower(): u.id for u in db.query(User.id, User.email).filter(User.is_active == True).all()}
    for n, row in enumerate(reader, start=2):
        if n > 2001:
            errors.append({"row": n, "error": "Only the first 2,000 rows are imported"}); break
        r = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        name = r.get("Customer", "")
        if not name:
            continue
        try:
            contacts = []
            if r.get("Contact name"):
                contacts.append(ContactCreate(contact_name=r["Contact name"], designation=r.get("Contact designation") or "",
                                              department=r.get("Contact department") or "", mobile=r.get("Contact phone") or "",
                                              office_email=r.get("Contact email") or None, is_primary=True))
            payload = CustomerCreate(
                customer_name=name, customer_vertical=r.get("Type") or None, division=r.get("Sub-segment") or None,
                billing_city=r.get("City") or None, billing_state=r.get("State") or None, gst_number=r.get("GST") or None,
                account_status=r.get("Status") if r.get("Status") in S.STATUSES else "Prospect",
                account_potential=S.POTENTIAL_OF.get((r.get("Tier") or "B").upper(), "Medium"),
                assigned_to=users.get((r.get("KAM email") or "").lower()), contacts=contacts or None,
            )
            create_customer(payload, request, db=db, current_user=cu)
            created += 1
        except HTTPException as exc:
            db.rollback(); errors.append({"row": n, "customer": name, "error": detail_text(exc.detail, "Rejected")})
        except Exception as exc:  # validation errors (GST format, name rules …)
            db.rollback()
            msg = exc.errors()[0].get("msg", str(exc)) if hasattr(exc, "errors") else str(exc)
            errors.append({"row": n, "customer": name, "error": str(msg).replace("Value error, ", "")[:200]})
    return {"created": created, "errors": errors[:200], "error_count": len(errors)}


# ─── Customer 360 ─────────────────────────────────────────────────────────────

@router.get("/{customer_id}")
def customer_360(customer_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    get_customer(db, cu, customer_id)
    every = all_customers(db)
    c = next((x for x in every if x.id == customer_id), None)
    if not c:
        raise HTTPException(404, "Customer not found")
    return D.build_360(db, cu, c, every, S.account_metrics(db))


@router.get("/{customer_id}/segment")
def segment(customer_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    get_customer(db, cu, customer_id)
    every = all_customers(db)
    c = next(x for x in every if x.id == customer_id)
    return D.segment_tab(db, c, every, S.account_metrics(db))


@router.get("/{customer_id}/hierarchy")
def hierarchy(customer_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    c = get_customer(db, cu, customer_id)
    return D.hierarchy_tab(db, cu, c, S.account_metrics(db))


def _profile(db: Session, cid: int) -> CustomerProfile:
    p = db.query(CustomerProfile).filter(CustomerProfile.customer_id == cid).first()
    if not p:
        p = CustomerProfile(customer_id=cid)
        db.add(p)
        db.flush()
    return p


class HierIn(BaseModel):
    kam_mode: Optional[Literal["Own KAM", "Inherit from parent"]] = None
    kam_id: Optional[int] = None
    level: Optional[Literal["Head Office", "LHO / Regional Office", "Zone", "Divisional Office", "Branch / Site"]] = None


@router.put("/{customer_id}/hierarchy")
def set_hierarchy(customer_id: int, body: HierIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    _need(db, cu, "customers.update", "edit customers")
    c = get_customer(db, cu, customer_id)
    p = _profile(db, c.id)
    old = {"kam_mode": p.kam_mode, "level": p.hierarchy_level}
    if body.kam_mode == "Inherit from parent" and not c.parent_account_id:
        raise HTTPException(422, "A top-level customer has no parent to inherit a KAM from")
    if body.kam_mode:
        p.kam_mode = body.kam_mode
    if body.level:
        p.hierarchy_level = body.level
    log_audit_db(db, cu.id, "customers", "hierarchy", c.id, get_request_ip(request), "Customer hierarchy settings changed",
                 old_data=old, new_data={"kam_mode": p.kam_mode, "level": p.hierarchy_level}, record_name=c.customer_name)
    db.commit()
    if body.kam_id is not None and body.kam_mode != "Inherit from parent":
        _apply_field(db, cu, request, c, "kam", str(body.kam_id) if body.kam_id else "")
    return D.hierarchy_tab(db, cu, get_customer(db, cu, customer_id), S.account_metrics(db))


class ChildIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=300)
    level: Literal["Head Office", "LHO / Regional Office", "Zone", "Divisional Office", "Branch / Site"]
    city: Optional[str] = Field(None, max_length=100)
    kam_mode: Literal["Own KAM", "Inherit from parent"] = "Inherit from parent"
    kam_id: Optional[int] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return V.check_text(v, "Entity name", 2, 300, required=True)

    @field_validator("city")
    @classmethod
    def _city(cls, v: Optional[str]) -> Optional[str]:
        return V.check_text(v, "City", 2, 100)


@router.post("/{customer_id}/children", status_code=201)
def add_child(customer_id: int, body: ChildIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    from app.routers.customer_router import CustomerCreate, create_customer
    _need(db, cu, "customers.create", "create customers")
    parent = get_customer(db, cu, customer_id)
    if body.kam_mode == "Own KAM" and not body.kam_id:
        raise V.field_error("kam_id", "Choose the KAM for this entity.")
    child = create_customer(CustomerCreate(
        customer_name=body.name.strip(), customer_vertical=parent.customer_vertical, division=parent.division,
        group_name=parent.group_name, parent_account_id=parent.id, billing_city=body.city or parent.billing_city,
        billing_state=parent.billing_state, billing_country=parent.billing_country, account_status="Active",
        account_potential="Low", assigned_to=body.kam_id if body.kam_mode == "Own KAM" else (parent.assigned_to or cu.id),
    ), request, db=db, current_user=cu)
    p = _profile(db, child.id)
    p.hierarchy_level, p.kam_mode = body.level, body.kam_mode
    db.commit()
    return {"id": child.id, "name": child.customer_name}


# ─── contacts ─────────────────────────────────────────────────────────────────

class ContactIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    designation: str = Field("", max_length=100)
    department: str = Field("", max_length=100)
    phone: str = Field("", max_length=20)
    email: Optional[str] = Field(None, max_length=100)
    buying_role: Optional[Literal["Decision maker", "Influencer", "User", "Gatekeeper"]] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return V.check_text(v, "Name", 2, 100, required=True)

    @field_validator("designation", "department")
    @classmethod
    def _req(cls, v: str, info) -> str:
        return V.check_text(v, info.field_name.capitalize(), 2, 100, required=True)

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        if not (v or "").strip():
            raise ValueError("Phone is required.")
        return V.check_mobile(v, "Phone number")

    @field_validator("email")
    @classmethod
    def _email(cls, v: Optional[str]) -> Optional[str]:
        return V.check_email(v)


@router.post("/{customer_id}/contacts", status_code=201)
def add_contact(customer_id: int, body: ContactIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    from pydantic import ValidationError
    from app.routers.customer_router import ContactCreate
    from app.services.inbox_service import EMAIL_RE
    _need(db, cu, "customers.update", "add contacts")
    c = get_customer(db, cu, customer_id)
    email = (body.email or "").strip()
    phone = body.phone.strip()   # already validated + normalised by ContactIn (same rules as the customer form)
    # duplicates: the same mobile or email already on this customer's active contacts
    if db.query(CustomerContact.id).filter(CustomerContact.customer_id == c.id, CustomerContact.is_active == True,  # noqa: E712
                                           CustomerContact.mobile == phone).first():
        raise V.field_error("phone", "A contact with this phone number already exists for this customer.", 409)
    if email and db.query(CustomerContact.id).filter(CustomerContact.customer_id == c.id, CustomerContact.is_active == True,  # noqa: E712
                                                     func.lower(CustomerContact.office_email) == email.lower()).first():
        raise V.field_error("email", "A contact with this email already exists for this customer.", 409)
    first = not db.query(CustomerContact.id).filter(CustomerContact.customer_id == c.id, CustomerContact.is_active == True).first()
    ct = CustomerContact(customer_id=c.id, contact_name=body.name.strip(), designation=body.designation.strip(), department=body.department.strip(),
                         mobile=phone or None, office_email=email or None, is_primary=first, is_active=True, created_by=cu.id)
    db.add(ct)
    db.flush()
    if body.buying_role:
        db.add(CustomerContactRole(contact_id=ct.id, customer_id=c.id, buying_role=body.buying_role))
    log_audit_db(db, cu.id, "customers", "contact_add", c.id, get_request_ip(request), f"Contact {ct.contact_name} added",
                 new_data={"contact": ct.contact_name, "designation": ct.designation, "buying_role": body.buying_role}, record_name=c.customer_name)
    db.commit()
    return next((x for x in S.contact_list(db, c.id) if x["id"] == ct.id), {"id": ct.id})


class RoleIn(BaseModel):
    buying_role: Optional[Literal["Decision maker", "Influencer", "User", "Gatekeeper"]] = None


@router.put("/{customer_id}/contacts/{contact_id}/role")
def set_role(customer_id: int, contact_id: int, body: RoleIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    _need(db, cu, "customers.update", "edit contacts")
    c = get_customer(db, cu, customer_id)
    ct = db.query(CustomerContact).filter(CustomerContact.id == contact_id, CustomerContact.customer_id == c.id).first()
    if not ct:
        raise HTTPException(404, "Contact not found")
    r = db.query(CustomerContactRole).filter(CustomerContactRole.contact_id == contact_id).first()
    if body.buying_role is None:
        if r:
            db.delete(r)
    elif r:
        r.buying_role = body.buying_role
    else:
        db.add(CustomerContactRole(contact_id=contact_id, customer_id=c.id, buying_role=body.buying_role))
    log_audit_db(db, cu.id, "customers", "contact_role", c.id, get_request_ip(request), f"Buying role of {ct.contact_name}: {body.buying_role or 'cleared'}",
                 record_name=c.customer_name)
    db.commit()
    return {"ok": True}


# ─── account plan ─────────────────────────────────────────────────────────────

class PlanIn(BaseModel):
    field: Literal["goal", "strategy", "risks", "white_space"]
    value: str = Field("", max_length=5000)


@router.put("/{customer_id}/plan")
def save_plan(customer_id: int, body: PlanIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(c360_user)):
    _need(db, cu, "customers.update", "edit the account plan")
    c = get_customer(db, cu, customer_id)
    p = _profile(db, c.id)
    col = {"goal": "plan_goal", "strategy": "plan_strategy", "risks": "plan_risks", "white_space": "plan_white_space"}[body.field]
    old = getattr(p, col)
    new = body.value.strip() or None
    if old != new:
        setattr(p, col, new)
        p.plan_updated_by, p.plan_updated_at = cu.id, now_ist()
        log_audit_db(db, cu.id, "customers", "account_plan", c.id, get_request_ip(request), f"Account plan – {body.field.replace('_', ' ')} updated",
                     old_data={body.field: old}, new_data={body.field: new}, record_name=c.customer_name)
        db.commit()
    return D.plan_of(db, c.id, p)
