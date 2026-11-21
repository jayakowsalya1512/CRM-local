"""
KAM 360 Router — Full rebuild with enhanced 360 dashboard.

New endpoints:
  POST /kam/targets               — set activity + sales targets (manager/CEO/admin only)
  GET  /kam/targets/summary       — target summary for a user/period
  GET  /kam/360-summary           — top-level summary cards (customers, acts, leads, tenders, WOs)
  GET  /kam/customer-activities   — per-customer activity breakdown with lead/tender/WO counts
  GET  /kam/team-360              — per-member summary for manager/admin 360 view
"""

import json, logging, calendar
from datetime import date, datetime, timezone
from app.core.timezone import now_ist, today_ist
from decimal import Decimal
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session
from sqlalchemy import func, or_
from pydantic import BaseModel, field_validator

from app.dependencies import get_tenant_db, get_current_user
from app.models.all_models import (
    KAMActivity, KAMTarget, KAMTravelExpense, KAMTaskAssignment,
    KAMLeadLink, KAMWorkOrder, User, Customer, ActivityLog,
    TravelRequest, SalesCustomerAssignment, Lead, Tender,
)
from app.services.travel_approval_service import submit_travel_request_with_policy

logger = logging.getLogger(__name__)
router = APIRouter()

SENIOR_ROLES  = ("admin", "ceo")
ADMIN_ROLES   = ("admin", "ceo", "vp", "manager")
MANAGER_ROLES = ("admin", "vp", "manager")

ACTIVITY_TYPES = ["Phone Call","Video Call","In Person Meet","Demo","Site Visit","Follow Up","Email"]
# DB_ACTIVITY_TYPES = ["Daily Call","Meeting","Demo","Site Visit","Follow up","Email","Presentation","Proposal","Task"]
TRAVEL_MODES   = ["Own Vehicle","Company Vehicle","Train","Bus","Auto/Cab"]

FOLLOWUP_CATEGORIES = {
    "Technical":    ["Product Demo","PoC Support","Spec Clarification","Installation Support"],
    "Commercial":   ["Price Negotiation","Payment Follow-up","Order Confirmation","Quotation Review"],
    "Tender":       ["Tender Submission","Bid Clarification","Rate Revision","L1 Negotiation"],
    "Support":      ["AMC Renewal","Complaint Resolution","Escalation","SLA Review"],
    "Relationship": ["Executive Visit","Review Meeting","Reference Request","Event Invite"],
}

CANCELLATION_REASONS = [
    "Customer unavailable","Customer rescheduled","Internal priority change",
    "Travel issue","Technical issue","Customer cancelled","Weather / force majeure","Other",
]


# ─── Utils ────────────────────────────────────────────────────────────────────

def _none(v):
    return None if v is None or (isinstance(v, str) and not v.strip()) else v


def _get_tenant_id(request: Request) -> Optional[int]:
    tenant = getattr(request.state, "tenant", None)
    tenant_id = getattr(tenant, "id", None)
    return int(tenant_id) if isinstance(tenant_id, int) else tenant_id

def _safe_get(obj, field, default=None):
    try:
        v = getattr(obj, field, default)
        return default if v is None else v
    except Exception:
        return default

def _normalize_activity_type(value):
    value = (value or "Phone Call").strip()
    if value not in ACTIVITY_TYPES:
        raise HTTPException(400, f"Invalid activity_type: {value}")
    return value

def _activity_mode_for_type(value, current=None):
    if value == "Video Call":
        return "Video Call"
    if value in ("In Person Meet", "Meeting", "Site Visit", "Demo"):
        return "In Person Meet"
    if value == "Email":
        return "Email"
    if value in ("Phone Call", "Daily Call"):
        return "Phone Call"
    if value in ("Follow Up", "Follow-up"):
        return "Follow Up"
    return current or "Phone Call"

def _activity_type_name(activity_type, mode=None):
    return activity_type or "Phone Call"

def _contacts_to_db(c): return json.dumps(c) if c and not isinstance(c, str) else (c or None)
def _contacts_from_db(raw):
    if not raw: return []
    if isinstance(raw, list): return raw
    try: return json.loads(raw)
    except: return []

def _valid_cols(model): return {c.name for c in model.__table__.columns}

def _tr_num(db):
    n = db.query(func.count(TravelRequest.id)).scalar() or 0
    return f"TR-{now_ist().strftime('%Y%m')}-{n+1:04d}"

def _period_range(period):
    y, m = int(period[:4]), int(period[5:7])
    return f"{period}-01", f"{period}-{calendar.monthrange(y,m)[1]:02d}"

def _quarter_range(year, q):
    sm = (q-1)*3+1; em = sm+2
    return f"{year}-{sm:02d}-01", f"{year}-{em:02d}-{calendar.monthrange(year,em)[1]:02d}"


# ─── Role / visibility ────────────────────────────────────────────────────────

def _get_team_uids(cu, db):
    if cu.role in SENIOR_ROLES:
        return [r.id for r in db.query(User.id).filter(User.is_active==True).all()]
    if cu.role in ("vp","manager"):
        team = db.query(User.id).filter(User.reporting_manager_id==cu.id, User.is_active==True).all()
        return [cu.id] + [r.id for r in team]
    return [cu.id]

def _get_visible_uids(cu, db, requested_uid=None):
    uids = _get_team_uids(cu, db)
    if requested_uid:
        if requested_uid in uids: return [requested_uid]
        raise HTTPException(403, "Not authorised")
    return uids


# ─── Customer helpers ─────────────────────────────────────────────────────────

def _get_customers_for_user(uid, role, db):
    def _fmt(custs):
        return [{"id": c.id, "customer_name": c.customer_name,
                 "city": c.billing_city, "vertical": c.customer_vertical}
                for c in custs]

    # ── CEO / Super Admin: all active, non-deleted customers ──────────────────
    if role in SENIOR_ROLES:
        custs = db.query(Customer).filter(
            Customer.is_deleted == False, Customer.is_active == True
        ).all()
        return _fmt(custs)

    # ── Manager / VP: self + direct reports ───────────────────────────────────
    if role in ("manager", "vp"):
        team_ids = [r.id for r in db.query(User.id).filter(
            User.reporting_manager_id == uid).all()]
        scope_ids = [uid] + team_ids
    else:
        # Sales and other roles: self only
        scope_ids = [uid]

    # From customers table: created_by OR assigned_to in scope_ids
    cust_map = {c.id: c for c in db.query(Customer).filter(
        or_(Customer.created_by.in_(scope_ids), Customer.assigned_to.in_(scope_ids)),
        Customer.is_deleted == False,
        Customer.is_active == True,
    ).all()}

    # From leads table: assigned_to in scope_ids → merge customer_ids
    lead_cust_ids = {r.customer_id for r in db.query(Lead.customer_id).filter(
        Lead.assigned_to.in_(scope_ids),
        Lead.is_deleted == False,
        Lead.customer_id != None,
    ).all()}
    if lead_cust_ids:
        for c in db.query(Customer).filter(
            Customer.id.in_(lead_cust_ids),
            Customer.is_deleted == False,
            Customer.is_active == True,
        ).all():
            cust_map[c.id] = c

    return _fmt(cust_map.values())

def _get_all_assignable_users(cu, db):
    uids = _get_team_uids(cu, db)
    return [{"id":u.id,"full_name":u.full_name,"role":u.role,"is_self":u.id==cu.id}
            for u in db.query(User).filter(User.id.in_(uids), User.is_active==True).all()]

def _customer_count_for_uids(uids, db):
    if not uids: return 0
    ids = set()
    for uid in uids:
        ids |= {r.customer_id for r in db.query(SalesCustomerAssignment.customer_id).filter(
            SalesCustomerAssignment.user_id==uid, SalesCustomerAssignment.is_active==True).all()}
        ids |= {r.customer_id for r in db.query(Lead.customer_id).filter(
            Lead.assigned_to==uid, Lead.is_deleted==False, Lead.customer_id!=None).all()}
    return len(ids)


# ─── Enrich activity ──────────────────────────────────────────────────────────

def _enrich_activity(row, db):
    d = {c.name: (_contacts_from_db(getattr(row,c.name)) if c.name=="contacts_met" else getattr(row,c.name)) for c in row.__table__.columns}
    d["task_type_name"] = _activity_type_name(d.get("activity_type"), d.get("mode"))
    for f, dflt in [("outcome",None),("next_action",None),("next_action_date",None),("contacts_met",[]),
                    ("followup_category",None),("followup_sub_type",None),("followup_ref_id",None),
                    ("cancellation_reason",None),("has_travel",False),("travel_mode",None),
                    ("travel_from",None),("travel_to",None),("is_outside_district",False),
                    ("travel_approved",None),("travel_request_id",None),("on_behalf_of",None),("user_role",None)]:
        if f not in d: d[f] = dflt
    u = db.query(User).filter(User.id==row.user_id).first()
    d["user_name"] = u.full_name if u else ""
    d["user_role"] = u.role if u else ""
    if row.customer_id:
        c = db.query(Customer).filter(Customer.id==row.customer_id).first()
        d["customer_name"] = c.customer_name if c else ""
    else:
        d["customer_name"] = ""
    tr_id = _safe_get(row,"travel_request_id")
    if tr_id:
        tr = db.query(TravelRequest).filter(TravelRequest.id==tr_id).first()
        d["travel_request_status"] = tr.status if tr else None
        d["travel_request_number"] = tr.request_number if tr else None
    else:
        d["travel_request_status"] = d["travel_request_number"] = None
    return d

def _auto_travel_request(db, act, cu, needs_approval, extra=None, tenant_id: Optional[int] = None):
    extra = extra or {}
    cust_name = ""
    if act.customer_id:
        c = db.query(Customer).filter(Customer.id==act.customer_id).first()
        cust_name = c.customer_name if c else ""
    tr_cols = _valid_cols(TravelRequest)
    travel_date = extra.get("tr_travel_date") or act.activity_date
    return_date = extra.get("tr_return_date") or travel_date
    total_days  = max(1, (return_date - travel_date).days + 1) if return_date else 1
    kw = dict(
        request_number=_tr_num(db),
        employee_id=act.user_id,
        purpose=f"KAM Activity: {act.subject}" + (f" @ {cust_name}" if cust_name else ""),
        visit_type=extra.get("tr_visit_type") or ("Customer Visit" if act.customer_id else "Site Visit"),
        customer_id=act.customer_id,
        from_city=_safe_get(act,"travel_from") or "Base Location",
        to_city=_safe_get(act,"travel_to") or _safe_get(act,"location") or "Destination",
        travel_date=travel_date,
        return_date=return_date,
        total_days=total_days,
        is_outside_district=_safe_get(act,"is_outside_district",False),
        transport_mode=extra.get("tr_transport_mode") or _safe_get(act,"travel_mode") or None,
        vehicle_number=extra.get("tr_vehicle_number"),
        estimated_kms=extra.get("tr_estimated_kms"),
        advance_booking_ref=extra.get("tr_advance_booking_ref"),
        estimated_total=extra.get("tr_estimated_cost") or 0,
        advance_required=extra.get("tr_advance_required") or False,
        advance_amount=extra.get("tr_advance_amount") or 0,
        accommodation_required=extra.get("tr_accommodation_required") or False,
        accommodation_type=extra.get("tr_accommodation_type") or "Not Required",
        hotel_name=extra.get("tr_hotel_name"),
        check_in_date=extra.get("tr_check_in_date"),
        check_out_date=extra.get("tr_check_out_date"),
        accommodation_cost=extra.get("tr_accommodation_cost") or 0,
        companions=extra.get("tr_companions"),
        contact_name=extra.get("tr_contact_name"),
        contact_phone=extra.get("tr_contact_phone"),
        notes=extra.get("tr_notes") or f"Auto-created from KAM activity #{act.id}",
        opportunity_id=extra.get("tr_opportunity_id"),
        lead_id=extra.get("tr_lead_id"),
        tender_id=extra.get("tr_tender_id"),
        status="Draft",
    )
    if "source" in tr_cols: kw["source"] = "kam"
    if "kam_activity_id" in tr_cols: kw["kam_activity_id"] = act.id
    tr = TravelRequest(**{k:v for k,v in kw.items() if k in tr_cols})
    db.add(tr); db.flush()
    # Auto-submit for approval when outside district
    if needs_approval:
        try:
            act_user = db.query(User).filter(User.id==act.user_id).first()
            submit_travel_request_with_policy(
                db,
                tr,
                actor=act_user or cu,
                requester=act_user or cu,
                tenant_id=tenant_id,
            )
        except Exception:
            pass  # Don't block activity save if auto-submit fails
    return tr


def _update_travel_request_details(tr, extra):
    """Patch an existing TravelRequest with the full detail fields from extra."""
    tr_cols = _valid_cols(TravelRequest)
    field_map = {
        "tr_travel_date":           "travel_date",
        "travel_from":              "from_city",
        "travel_to":                "to_city",
        "tr_visit_type":             "visit_type",
        "tr_return_date":            "return_date",
        "tr_transport_mode":         "transport_mode",
        "tr_vehicle_number":         "vehicle_number",
        "tr_estimated_kms":          "estimated_kms",
        "tr_advance_booking_ref":    "advance_booking_ref",
        "tr_estimated_cost":         "estimated_total",
        "tr_advance_required":       "advance_required",
        "tr_advance_amount":         "advance_amount",
        "tr_accommodation_required": "accommodation_required",
        "tr_accommodation_type":     "accommodation_type",
        "tr_hotel_name":             "hotel_name",
        "tr_check_in_date":          "check_in_date",
        "tr_check_out_date":         "check_out_date",
        "tr_accommodation_cost":     "accommodation_cost",
        "tr_companions":             "companions",
        "tr_contact_name":           "contact_name",
        "tr_contact_phone":          "contact_phone",
        "tr_notes":                  "notes",
        "tr_opportunity_id":         "opportunity_id",
        "tr_lead_id":                "lead_id",
        "tr_tender_id":              "tender_id",
    }
    for src, dst in field_map.items():
        if src in extra and extra[src] is not None and dst in tr_cols:
            setattr(tr, dst, extra[src])
    if ("tr_travel_date" in extra or "tr_return_date" in extra) and "total_days" in tr_cols:
        from_date = extra.get("tr_travel_date") or tr.travel_date
        return_date = extra.get("tr_return_date") or tr.return_date
        try:
            tr.total_days = max(1, (return_date - from_date).days + 1)
        except Exception:
            pass


# ─── Stats helpers ────────────────────────────────────────────────────────────

def _lead_stats(uids, db):
    leads = db.query(Lead).filter(Lead.assigned_to.in_(uids), Lead.is_deleted==False).all()
    return {"lead_count":len(leads), "lead_value":float(sum(float(l.est_value or 0) for l in leads))}

def _tender_stats(uids, db):
    tenders = db.query(Tender).filter(Tender.assigned_to.in_(uids), Tender.is_deleted==False).all()
    won = [t for t in tenders if t.result == 'Won']
    return {
        "tender_count":      len(tenders),
        "tender_value":      float(sum(float(t.est_value  or 0) for t in tenders)),
        "won_tender_count":  len(won),
        "won_tender_value":  float(sum(float(t.bid_amount or 0) for t in won)),
    }

def _wo_stats(uids, db):
    wos = db.query(KAMWorkOrder).filter(KAMWorkOrder.user_id.in_(uids)).all()
    return {"wo_count":len(wos), "wo_value":float(sum(x.order_value or 0 for x in wos)),
            "payment_received":float(sum(x.payment_received or 0 for x in wos)), "wos":wos}


# ─── Schemas ──────────────────────────────────────────────────────────────────

class ActivityCreate(BaseModel):
    activity_type: str = "Phone Call"
    customer_id: Optional[int] = None
    subject: str
    description: Optional[str] = None
    activity_date: date
    start_time: Optional[str] = None
    duration_minutes: Optional[int] = None
    location: Optional[str] = None
    mode: str = "Phone"
    status: str = "Planned"
    outcome: Optional[str] = None
    next_action: Optional[str] = None
    next_action_date: Optional[date] = None
    contacts_met: Optional[List[int]] = None
    followup_category: Optional[str] = None
    followup_sub_type: Optional[str] = None
    cancellation_reason: Optional[str] = None
    has_travel: bool = False
    travel_mode: Optional[str] = None
    travel_from: Optional[str] = None
    travel_to: Optional[str] = None
    is_outside_district: bool = False
    on_behalf_of: Optional[int] = None

    @field_validator("start_time","next_action_date",mode="before")
    @classmethod
    def _ct(cls,v): return None if v is None or (isinstance(v,str) and not v.strip()) else v

    @field_validator("description","location","outcome","next_action","followup_category",
                     "followup_sub_type","cancellation_reason","travel_mode","travel_from","travel_to",mode="before")
    @classmethod
    def _cs(cls,v): return None if isinstance(v,str) and not v.strip() else v


class ActivityUpdate(BaseModel):
    activity_type: Optional[str]=None; customer_id: Optional[int]=None
    subject: Optional[str]=None; description: Optional[str]=None
    activity_date: Optional[date]=None; start_time: Optional[str]=None
    duration_minutes: Optional[int]=None; location: Optional[str]=None
    mode: Optional[str]=None; status: Optional[str]=None
    outcome: Optional[str]=None; next_action: Optional[str]=None
    next_action_date: Optional[date]=None; cancellation_reason: Optional[str]=None
    followup_category: Optional[str]=None; followup_sub_type: Optional[str]=None
    has_travel: Optional[bool]=None; travel_mode: Optional[str]=None
    travel_from: Optional[str]=None; travel_to: Optional[str]=None
    is_outside_district: Optional[bool]=None
    # Full travel request detail fields (used to enrich the auto-created TravelRequest)
    tr_visit_type: Optional[str] = None
    tr_return_date: Optional[date] = None
    tr_transport_mode: Optional[str] = None
    tr_vehicle_number: Optional[str] = None
    tr_estimated_kms: Optional[float] = None
    tr_advance_booking_ref: Optional[str] = None
    tr_estimated_cost: Optional[float] = None
    tr_advance_required: Optional[bool] = None
    tr_advance_amount: Optional[float] = None
    tr_accommodation_required: Optional[bool] = None
    tr_accommodation_type: Optional[str] = None
    tr_hotel_name: Optional[str] = None
    tr_check_in_date: Optional[date] = None
    tr_check_out_date: Optional[date] = None
    tr_accommodation_cost: Optional[float] = None
    tr_companions: Optional[str] = None
    tr_contact_name: Optional[str] = None
    tr_contact_phone: Optional[str] = None
    tr_notes: Optional[str] = None
    # CRM linkage for travel request
    tr_opportunity_id: Optional[int] = None
    tr_lead_id: Optional[int] = None
    tr_tender_id: Optional[int] = None

    tr_travel_date: Optional[date] = None  # separate travel departure date (may differ from activity_date)

    @field_validator("start_time","next_action_date","activity_date","tr_return_date",
                     "tr_check_in_date","tr_check_out_date","tr_travel_date",mode="before")
    @classmethod
    def _ct(cls,v): return None if v is None or (isinstance(v,str) and not v.strip()) else v

    @field_validator("description","location","outcome","next_action","followup_category",
                     "followup_sub_type","cancellation_reason","travel_mode","travel_from","travel_to",
                     "tr_visit_type","tr_transport_mode","tr_vehicle_number","tr_advance_booking_ref",
                     "tr_accommodation_type","tr_hotel_name","tr_companions","tr_contact_name",
                     "tr_contact_phone","tr_notes",mode="before")
    @classmethod
    def _cs(cls,v): return None if isinstance(v,str) and not v.strip() else v

    # Explicit travel request link (used when frontend links an existing TR)
    travel_request_id: Optional[int] = None

    @field_validator("tr_opportunity_id","tr_lead_id","tr_tender_id","travel_request_id",mode="before")
    @classmethod
    def _ci(cls,v): return None if v is None or (isinstance(v,str) and not v.strip()) else (int(v) if isinstance(v,str) else v)


class BulkPlanItem(BaseModel):
    activity_type: str = "Phone Call"
    customer_id: int; subject: str; activity_date: date
    mode: Optional[str] = None
    on_behalf_of: Optional[int] = None


class TargetCreate(BaseModel):
    user_id: int
    period: str                  # "2025-06" monthly  OR  "2025" yearly
    calls_target: int = 0
    meetings_target: int = 0
    leads_target: int = 0
    revenue_target: float = 0
    demos_target: int = 0
    site_visits_target: int = 0
    sales_target: float = 0      # rupee sales target e.g. 10000000 = 1 Cr


# ─── Meta ─────────────────────────────────────────────────────────────────────

@router.get("/meta")
def get_meta():
    return {"activity_types":ACTIVITY_TYPES,"followup_categories":FOLLOWUP_CATEGORIES,
            "cancellation_reasons":CANCELLATION_REASONS,"travel_modes":TRAVEL_MODES,
            "statuses":["Planned","In Progress","Completed","Cancelled","Postponed"],
            "modes":["In-Person","Phone","Video Call","Email"]}


# ─── Team / Customers ─────────────────────────────────────────────────────────

@router.get("/team-members")
def get_team_members(db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    return _get_all_assignable_users(cu, db)

@router.get("/plan-customers")
def get_plan_customers(user_id: Optional[int]=None, db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    target_uid, target_role = cu.id, cu.role
    if user_id and user_id != cu.id:
        if user_id not in _get_team_uids(cu, db): raise HTTPException(403,"Not authorised")
        u = db.query(User).filter(User.id==user_id, User.is_active==True).first()
        if not u: raise HTTPException(404,"User not found")
        target_uid, target_role = u.id, u.role
    return _get_customers_for_user(target_uid, target_role, db)


# ─── Activities CRUD ──────────────────────────────────────────────────────────

@router.get("/activities")
def list_activities(user_id: Optional[int]=None, activity_type: Optional[str]=None,
                    status: Optional[str]=None, date_from: Optional[str]=None,
                    date_to: Optional[str]=None, customer_id: Optional[int]=None,
                    activity_date: Optional[str]=None,
                    db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    uids = _get_visible_uids(cu, db, requested_uid=user_id)
    q = db.query(KAMActivity).filter(KAMActivity.user_id.in_(uids))
    if activity_type:
        db_activity_type = _normalize_activity_type(activity_type)
        type_filters = [KAMActivity.activity_type==db_activity_type]
        if db_activity_type != activity_type:
            type_filters.append(KAMActivity.activity_type==activity_type)
        q=q.filter(or_(*type_filters))
        if activity_type == "Video Call":
            q=q.filter(or_(KAMActivity.mode=="Video Call", KAMActivity.activity_type=="Video Call"))
        elif activity_type == "Phone Call":
            q=q.filter(or_(KAMActivity.mode=="Phone", KAMActivity.mode.is_(None), KAMActivity.activity_type=="Phone Call"))
    if status:        q=q.filter(KAMActivity.status==status)
    if activity_date: q=q.filter(KAMActivity.activity_date==activity_date)
    if date_from:     q=q.filter(KAMActivity.activity_date>=date_from)
    if date_to:       q=q.filter(KAMActivity.activity_date<=date_to)
    if customer_id:   q=q.filter(KAMActivity.customer_id==customer_id)
    rows = q.order_by(KAMActivity.activity_date.desc(), KAMActivity.created_at.desc()).all()
    return [_enrich_activity(r,db) for r in rows]

@router.get("/activities/{activity_id}")
def get_activity(activity_id: int, db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    act = db.query(KAMActivity).filter(KAMActivity.id==activity_id).first()
    if not act: raise HTTPException(404,"Not found")
    if act.user_id not in _get_visible_uids(cu,db): raise HTTPException(403,"Not authorised")
    return _enrich_activity(act,db)

@router.post("/activities", status_code=201)
def create_activity(data: ActivityCreate, request: Request, db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    db_activity_type = _normalize_activity_type(data.activity_type)
    db_mode = _activity_mode_for_type(data.activity_type, data.mode)
    if data.on_behalf_of and cu.role in ADMIN_ROLES:
        if data.on_behalf_of not in _get_team_uids(cu,db): raise HTTPException(403,"Cannot create for this user")
        act_uid = data.on_behalf_of
    else:
        act_uid = cu.id
    if data.status=="Completed" and not (data.outcome or "").strip(): raise HTTPException(400,"Outcome required")
    if data.status=="Cancelled" and not (data.cancellation_reason or "").strip(): raise HTTPException(400,"Cancellation reason required")
    u = db.query(User).filter(User.id==act_uid).first()
    vcols = _valid_cols(KAMActivity)
    kw = dict(user_id=act_uid, user_role=u.role if u else None,
              on_behalf_of=data.on_behalf_of if cu.role in ADMIN_ROLES else None,
              activity_type=db_activity_type, customer_id=data.customer_id, subject=data.subject,
              description=_none(data.description), activity_date=data.activity_date,
              start_time=_none(data.start_time), duration_minutes=data.duration_minutes,
              location=_none(data.location), mode=db_mode, status=data.status,
              outcome=_none(data.outcome), next_action=_none(data.next_action),
              next_action_date=data.next_action_date, contacts_met=_contacts_to_db(data.contacts_met),
              cancellation_reason=_none(data.cancellation_reason),
              followup_category=_none(data.followup_category), followup_sub_type=_none(data.followup_sub_type),
              has_travel=data.has_travel, travel_mode=_none(data.travel_mode),
              travel_from=_none(data.travel_from), travel_to=_none(data.travel_to),
              is_outside_district=data.is_outside_district,
              travel_approved=None if not data.has_travel else (None if data.is_outside_district else True),
              created_by=cu.id)
    act = KAMActivity(**{k:v for k,v in kw.items() if k in vcols})
    db.add(act); db.flush()
    travel_req = None
    if data.has_travel and data.is_outside_district and "travel_request_id" in vcols:
        travel_req = _auto_travel_request(
            db,
            act,
            cu,
            data.is_outside_district,
            tenant_id=_get_tenant_id(request),
        )
        act.travel_request_id = travel_req.id
    db.add(ActivityLog(user_id=cu.id,module="kam",record_id=act.id,action="created",
                       description=f"KAM {_activity_type_name(db_activity_type, db_mode)}: {data.subject}",icon="📞",color="#EFF6FF"))
    db.commit(); db.refresh(act)
    result = _enrich_activity(act,db)
    if travel_req:
        result["auto_travel_request_id"] = travel_req.id
        result["auto_travel_request_number"] = travel_req.request_number
        result["travel_request_message"] = (f"Travel request {travel_req.request_number} created. "
            + ("Submit for manager approval." if data.is_outside_district else "Local travel recorded."))
    return result

@router.patch("/activities/{activity_id}")
def update_activity(activity_id: int, data: ActivityUpdate, request: Request, db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    act = db.query(KAMActivity).filter(KAMActivity.id==activity_id).first()
    if not act: raise HTTPException(404,"Not found")
    if act.user_id not in _get_visible_uids(cu,db): raise HTTPException(403,"Not authorised")
    if data.status=="Completed" and not (data.outcome or _safe_get(act,"outcome") or "").strip():
        raise HTTPException(400,"Outcome required")
    if data.status=="Cancelled" and not (data.cancellation_reason or _safe_get(act,"cancellation_reason") or "").strip():
        raise HTTPException(400,"Cancellation reason required")
    vcols = _valid_cols(KAMActivity)
    existing_tr_id = _safe_get(act,"travel_request_id")
    updates = data.model_dump(exclude_unset=True)
    incoming_activity_type = updates.get("activity_type")
    if incoming_activity_type:
        updates["activity_type"] = _normalize_activity_type(incoming_activity_type)
        updates["mode"] = _activity_mode_for_type(
            updates["activity_type"],
            updates.get("mode") or _safe_get(act, "mode")
        ) 
    for f,v in updates.items():
        if f not in vcols: continue
        if f=="start_time" and isinstance(v,str) and not v.strip(): v=None
        if v is not None: setattr(act,f,v)
    act.updated_at = now_ist()
    has_travel_now = updates.get("has_travel",_safe_get(act,"has_travel",False))
    tr_id = _safe_get(act,"travel_request_id")
    explicit_tr_link = "travel_request_id" in updates and updates.get("travel_request_id") != existing_tr_id
    # Collect the extra travel detail fields submitted by the frontend
    TR_EXTRA_KEYS = [
        "tr_travel_date","travel_from","travel_to",
        "tr_visit_type","tr_return_date","tr_transport_mode","tr_vehicle_number",
        "tr_estimated_kms","tr_advance_booking_ref","tr_estimated_cost",
        "tr_advance_required","tr_advance_amount","tr_accommodation_required",
        "tr_accommodation_type","tr_hotel_name","tr_check_in_date","tr_check_out_date",
        "tr_accommodation_cost","tr_companions","tr_contact_name","tr_contact_phone","tr_notes",
        "tr_opportunity_id","tr_lead_id","tr_tender_id",
    ]
    tr_extra = {k: updates[k] for k in TR_EXTRA_KEYS if k in updates}
    if has_travel_now and "travel_request_id" in vcols:
        is_outside = updates.get("is_outside_district",_safe_get(act,"is_outside_district",False))
        if explicit_tr_link:
            # User linked an existing TR — already set on act via the loop above; skip auto-create
            if tr_extra:
                existing_tr = db.query(TravelRequest).filter(TravelRequest.id==tr_id).first()
                if existing_tr and existing_tr.status in ("Draft","Rejected"):
                    _update_travel_request_details(existing_tr, tr_extra)
        elif not tr_id and is_outside:
            # Auto-create only when outside district and no TR linked yet (create mode)
            tr = _auto_travel_request(
                db,
                act,
                cu,
                is_outside,
                extra=tr_extra,
                tenant_id=_get_tenant_id(request),
            )
            act.travel_request_id = tr.id
            tr_id = tr.id
        else:
            # Update existing travel request with enriched details if provided
            if tr_extra:
                existing_tr = db.query(TravelRequest).filter(TravelRequest.id==tr_id).first()
                if existing_tr and existing_tr.status in ("Draft","Rejected"):
                    _update_travel_request_details(existing_tr, tr_extra)
    next_act_created = False
    nad = data.next_action_date or _safe_get(act,"next_action_date")
    nat = data.next_action or _safe_get(act,"next_action")
    if nad and nat:
        if not db.query(KAMActivity).filter(KAMActivity.user_id==act.user_id,
            KAMActivity.customer_id==act.customer_id, KAMActivity.activity_date==str(nad),
            KAMActivity.subject==nat, KAMActivity.status=="Planned").first():
            db.add(KAMActivity(**{k:v for k,v in dict(user_id=act.user_id,activity_type=act.activity_type,
                customer_id=act.customer_id,subject=nat,activity_date=str(nad),status="Planned",
                description=f"Follow-up from #{act.id}: {act.subject}",created_by=cu.id).items() if k in vcols}))
            next_act_created = True
    db.add(ActivityLog(user_id=cu.id,module="kam",record_id=act.id,action="updated",
                       description=f"Updated — {data.status or act.status}",icon="✏️",color="#F0FDF4"))
    db.commit(); db.refresh(act)
    result = _enrich_activity(act,db)
    result["follow_up_created"] = next_act_created
    # Include travel request info so frontend can show submit banner
    final_tr_id = _safe_get(act,"travel_request_id")
    if final_tr_id:
        final_tr = db.query(TravelRequest).filter(TravelRequest.id==final_tr_id).first()
        if final_tr:
            result["auto_travel_request_id"] = final_tr.id
            result["auto_travel_request_number"] = final_tr.request_number
            is_out = _safe_get(act,"is_outside_district",False)
            result["travel_request_message"] = (
                f"Travel request {final_tr.request_number} ready. "
                + ("Submit for manager approval." if is_out else "Local travel recorded.")
            )
    return result

@router.delete("/activities/{activity_id}")
def delete_activity(activity_id: int, db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    act = db.query(KAMActivity).filter(KAMActivity.id==activity_id).first()
    if not act: raise HTTPException(404,"Not found")
    if act.user_id not in _get_visible_uids(cu,db) or cu.role not in ADMIN_ROLES:
        raise HTTPException(403,"Not authorised")
    db.delete(act); db.commit()
    return {"message":"Deleted"}

@router.post("/activities/bulk", status_code=201)
def bulk_create_activities(
    items: List[BulkPlanItem],
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    vcols = _valid_cols(KAMActivity)
    team_uids = _get_team_uids(cu, db)
    created = []

    for item in items:
        if item.on_behalf_of and cu.role in ADMIN_ROLES:
            if item.on_behalf_of not in team_uids:
                raise HTTPException(403, f"Cannot assign to {item.on_behalf_of}")
            act_uid = item.on_behalf_of
        else:
            act_uid = cu.id

        u = db.query(User).filter(User.id == act_uid).first()

        db_activity_type = _normalize_activity_type(item.activity_type)
        db_mode = _activity_mode_for_type(item.activity_type, item.mode)

        act = KAMActivity(**{
            k: v for k, v in dict(
                user_id=act_uid,
                user_role=u.role if u else None,
                on_behalf_of=item.on_behalf_of if cu.role in ADMIN_ROLES else None,
                activity_type=db_activity_type,
                customer_id=item.customer_id,
                subject=item.subject,
                activity_date=item.activity_date,
                status="Planned",
                mode=db_mode,
                has_travel=False,
                is_outside_district=False,
                created_by=cu.id,
            ).items()
            if k in vcols
        })

        db.add(act)
        created.append(act)

    db.commit()

    return [_enrich_activity(a, db) for a in created]


# ─── Travel submit ────────────────────────────────────────────────────────────

@router.post("/travel-requests/{request_id}/submit")
def submit_travel_request(request_id: int, request: Request, db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    tr = db.query(TravelRequest).filter(TravelRequest.id==request_id).first()
    if not tr: raise HTTPException(404,"Not found")
    if tr.employee_id != cu.id and cu.role not in ADMIN_ROLES: raise HTTPException(403,"Not authorised")
    if tr.status not in ("Draft", "Rejected"):
        raise HTTPException(400, f"Cannot submit from status: {tr.status}")
    requester = db.query(User).filter(User.id == tr.employee_id).first()
    if not requester:
        raise HTTPException(404, "Requester not found")
    response = submit_travel_request_with_policy(
        db,
        tr,
        actor=cu,
        requester=requester,
        tenant_id=_get_tenant_id(request),
    )
    db.commit()
    return response


# ─── Targets ──────────────────────────────────────────────────────────────────

@router.get("/targets")
def list_targets(user_id: Optional[int]=None, period: Optional[str]=None,
                 db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    uids = _get_visible_uids(cu,db,requested_uid=user_id)
    q = db.query(KAMTarget).filter(KAMTarget.user_id.in_(uids))
    if period: q=q.filter(KAMTarget.period==period)
    rows = q.all()
    vcols = _valid_cols(KAMTarget)
    result = []
    for t in rows:
        d = {c.name:getattr(t,c.name) for c in t.__table__.columns}
        d["sales_target"] = float(getattr(t,"sales_target",0) or 0)
        result.append(d)
    return result


@router.post("/targets", status_code=201)
def set_target(data: TargetCreate, db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    """Set activity + rupee sales targets. Only manager / CEO / admin."""
    if cu.role not in ADMIN_ROLES:
        raise HTTPException(403,"Manager+ required to set targets")
    if data.user_id not in _get_team_uids(cu,db):
        raise HTTPException(403,"Cannot set target for this user")
    user = db.query(User).filter(User.id==data.user_id, User.is_active==True).first()
    if not user:
        raise HTTPException(404,"User not found")
    existing = db.query(KAMTarget).filter(KAMTarget.user_id==data.user_id,KAMTarget.period==data.period).first()
    vcols = _valid_cols(KAMTarget)
    payload = {k:v for k,v in data.model_dump().items() if k in vcols}
    # Keep the user master target in sync with the latest KAM sales target so it
    # appears in User Management as soon as managers assign it from KAM 360.
    sales_target_value = Decimal(str(data.sales_target or 0))
    user.target = sales_target_value if sales_target_value > 0 else None
    if existing:
        db.query(KAMTarget).filter(
            KAMTarget.user_id == data.user_id,
            KAMTarget.period == data.period,
        ).update(payload, synchronize_session=False)
        db.commit()
        db.refresh(existing)
        return existing
    t = KAMTarget(**{**payload,"created_by":cu.id})
    db.add(t); db.commit(); db.refresh(t)
    return t


@router.get("/targets/summary")
def get_target_summary(user_id: Optional[int]=None, period: Optional[str]=None,
                       db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    if not period: period = now_ist().strftime("%Y-%m")
    uid = user_id or cu.id
    if uid != cu.id and uid not in _get_team_uids(cu,db): raise HTTPException(403,"Not authorised")
    tgt = db.query(KAMTarget).filter(KAMTarget.user_id==uid,KAMTarget.period==period).first()
    u = db.query(User).filter(User.id==uid).first()
    return {"user_id":uid,"user_name":u.full_name if u else "","period":period,
            "calls_target":tgt.calls_target if tgt else 0,
            "meetings_target":tgt.meetings_target if tgt else 0,
            "demos_target":getattr(tgt,"demos_target",0) if tgt else 0,
            "site_visits_target":getattr(tgt,"site_visits_target",0) if tgt else 0,
            "revenue_target":float(tgt.revenue_target or 0) if tgt else 0,
            "sales_target":float(getattr(tgt,"sales_target",0) or 0) if tgt else 0,
            "has_target":tgt is not None}


# ─── KAM 360 Summary (top cards) ──────────────────────────────────────────────

@router.get("/360-summary")
def get_360_summary(user_id: Optional[int]=None, period: Optional[str]=None,
                    view_type: Optional[str]=None, year: Optional[int]=None,
                    db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    if not period: period = now_ist().strftime("%Y-%m")
    cy = year or int(period[:4])
    is_yearly = (view_type=="yearly")
    d_from,d_to = (f"{cy}-01-01",f"{cy}-12-31") if is_yearly else _period_range(period)

    is_agg = cu.role in ADMIN_ROLES and not user_id
    if user_id:
        scope_uids=[_get_visible_uids(cu,db,user_id)[0]]; uid=user_id
    elif is_agg:
        # _get_team_uids: admin/ceo → all users; manager/vp → self + direct reports
        scope_uids = _get_team_uids(cu, db)
        uid=None
    else:
        scope_uids=[cu.id]; uid=cu.id

    act_q=db.query(KAMActivity).filter(KAMActivity.activity_date.between(d_from,d_to))
    if uid: act_q=act_q.filter(KAMActivity.user_id==uid)
    else:   act_q=act_q.filter(KAMActivity.user_id.in_(scope_uids))
    activities=act_q.all()

    if uid:
        u_obj=db.query(User).filter(User.id==uid).first()
        cust_count=len(_get_customers_for_user(uid,u_obj.role if u_obj else "sales",db))
    else:
        cust_count=db.query(func.count(Customer.id)).filter(Customer.is_deleted==False).scalar() or 0

    ls=_lead_stats(scope_uids if uid is None else [uid],db)
    ts=_tender_stats(scope_uids if uid is None else [uid],db)
    wo=_wo_stats(scope_uids if uid is None else [uid],db)

    # ── Sales target: for manager/vp sum across self + team ───────────────────
    if cu.role in ("manager", "vp") and not user_id:
        team_ids = [r.id for r in db.query(User.id).filter(User.reporting_manager_id == cu.id).all()]
        target_scope = [cu.id] + team_ids
    elif uid:
        target_scope = [uid]
    else:
        target_scope = scope_uids

    tgts = db.query(KAMTarget).filter(
        KAMTarget.user_id.in_(target_scope),
        KAMTarget.period == period,
    ).all()
    sales_target = float(sum(float(getattr(t, "sales_target", 0) or 0) for t in tgts))

    return {"uid":uid,"is_aggregate":is_agg,"period":period,"year":cy,"is_yearly":is_yearly,
            "customers":cust_count,"total_activities":len(activities),
            "completed_activities":sum(1 for a in activities if a.status=="Completed"),
            "pending_activities":sum(1 for a in activities if a.status in ("Planned","In Progress")),
            **ls,**ts,"wo_count":wo["wo_count"],"wo_value":wo["wo_value"],
            "payment_received":wo["payment_received"],"sales_target":sales_target}


# ─── Customer-wise activity breakdown ─────────────────────────────────────────

@router.get("/customer-activities")
def get_customer_activities(user_id: Optional[int]=None, period: Optional[str]=None,
                            view_type: Optional[str]=None, year: Optional[int]=None,
                            db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    if not period: period = now_ist().strftime("%Y-%m")
    cy = year or int(period[:4])
    is_yearly = (view_type=="yearly")
    d_from,d_to = (f"{cy}-01-01",f"{cy}-12-31") if is_yearly else _period_range(period)

    is_agg = cu.role in ADMIN_ROLES and not user_id
    if user_id:
        scope_uids=[_get_visible_uids(cu,db,user_id)[0]]; uid=user_id
    elif is_agg:
        # _get_team_uids: admin/ceo → all users; manager/vp → self + direct reports
        scope_uids = _get_team_uids(cu, db)
        uid=None
    else:
        scope_uids=[cu.id]; uid=cu.id

    act_q=db.query(KAMActivity).filter(KAMActivity.activity_date.between(d_from,d_to))
    if uid: act_q=act_q.filter(KAMActivity.user_id==uid)
    else:   act_q=act_q.filter(KAMActivity.user_id.in_(scope_uids))
    activities=act_q.all()

    cust_ids=list({a.customer_id for a in activities if a.customer_id})
    result=[]
    for cid in cust_ids:
        cust=db.query(Customer).filter(Customer.id==cid).first()
        c_acts=[a for a in activities if a.customer_id==cid]
        c_lead_q=db.query(Lead).filter(Lead.customer_id==cid,Lead.is_deleted==False)
        c_tend_q=db.query(Tender).filter(Tender.customer_id==cid,Tender.is_deleted==False)
        c_wo_q=db.query(KAMWorkOrder).filter(KAMWorkOrder.customer_id==cid)
        if uid:
            c_lead_q=c_lead_q.filter(Lead.assigned_to==uid)
            c_tend_q=c_tend_q.filter(Tender.assigned_to==uid)
            c_wo_q=c_wo_q.filter(KAMWorkOrder.user_id==uid)
        else:
            c_lead_q=c_lead_q.filter(Lead.assigned_to.in_(scope_uids))
            c_tend_q=c_tend_q.filter(Tender.assigned_to.in_(scope_uids))
            c_wo_q=c_wo_q.filter(KAMWorkOrder.user_id.in_(scope_uids))
        c_leads=c_lead_q.all(); c_tenders=c_tend_q.all(); c_wos=c_wo_q.all()
        last_act=max((str(a.activity_date) for a in c_acts),default=None)
        last_outcome=next((a.outcome for a in sorted(c_acts,key=lambda x:x.activity_date,reverse=True) if a.outcome),None)
        result.append({
            "customer_id":cid,"customer_name":cust.customer_name if cust else "",
            "city":cust.billing_city if cust else "","vertical":cust.customer_vertical if cust else "",
            "total_activities":len(c_acts),
            "completed":sum(1 for a in c_acts if a.status=="Completed"),
            "pending":sum(1 for a in c_acts if a.status in ("Planned","In Progress")),
            "calls": sum(1 for a in c_acts if a.activity_type in ("Phone Call", "Video Call")),
            "calls_done": sum(1 for a in c_acts if a.activity_type in ("Phone Call", "Video Call") and a.status == "Completed"),
            "meetings": sum(1 for a in c_acts if a.activity_type == "In Person Meet"),
            "meetings_done": sum(1 for a in c_acts if a.activity_type == "In Person Meet" and a.status == "Completed"),
            "demos":sum(1 for a in c_acts if a.activity_type=="Demo"),
            "site_visits":sum(1 for a in c_acts if a.activity_type=="Site Visit"),
            "lead_count":len(c_leads),"lead_value":float(sum(float(l.est_value or 0) for l in c_leads)),
            "tender_count":len(c_tenders),"tender_value":float(sum(float(t.est_value or 0) for t in c_tenders)),
            "wo_count":len(c_wos),"wo_value":float(sum(x.order_value or 0 for x in c_wos)),
            "payment_received":float(sum(x.payment_received or 0 for x in c_wos)),
            "last_activity_date":last_act,"last_outcome":last_outcome,
        })
    result.sort(key=lambda x:x["total_activities"],reverse=True)
    return result


# ─── Team 360 (per-member for manager/admin) ─────────────────────────────────

@router.get("/team-360")
def get_team_360(period: Optional[str]=None, view_type: Optional[str]=None,
                 year: Optional[int]=None,
                 db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    if cu.role not in ADMIN_ROLES: raise HTTPException(403,"Manager+ required")
    if not period: period=now_ist().strftime("%Y-%m")
    cy=year or int(period[:4]); is_yearly=(view_type=="yearly")
    d_from,d_to=(f"{cy}-01-01",f"{cy}-12-31") if is_yearly else _period_range(period)
    uids=_get_team_uids(cu,db)
    members=[]
    for u in db.query(User).filter(User.id.in_(uids),User.is_active==True).all():
        if u.role in SENIOR_ROLES: continue
        acts=db.query(KAMActivity).filter(KAMActivity.user_id==u.id,KAMActivity.activity_date.between(d_from,d_to)).all()
        tgt=db.query(KAMTarget).filter(KAMTarget.user_id==u.id,KAMTarget.period==period).first()
        ls=_lead_stats([u.id],db); ts=_tender_stats([u.id],db); wo=_wo_stats([u.id],db)
        cust_count=len(_get_customers_for_user(u.id,u.role,db))
        members.append({"user_id":u.id,"user_name":u.full_name,"role":u.role,"is_self":u.id==cu.id,
            "customers":cust_count,"total":len(acts),
            "completed":sum(1 for a in acts if a.status=="Completed"),
            "pending":sum(1 for a in acts if a.status in ("Planned","In Progress")),
            "calls":sum(1 for a in acts if a.activity_type=="Daily Call" and a.status=="Completed"),
            "calls_total":sum(1 for a in acts if a.activity_type=="Daily Call"),
            "meetings":sum(1 for a in acts if a.activity_type=="Meeting" and a.status=="Completed"),
            "meetings_total":sum(1 for a in acts if a.activity_type=="Meeting"),
            "calls_target":tgt.calls_target if tgt else 0,
            "meetings_target":tgt.meetings_target if tgt else 0,
            "sales_target":float(getattr(tgt,"sales_target",0) or 0) if tgt else 0,
            **ls,**ts,"wo_count":wo["wo_count"],"wo_value":wo["wo_value"],
            "payment_received":wo["payment_received"]})
    members.sort(key=lambda m:(not m["is_self"],-m["completed"]))
    return {"period":period,"members":members}


# ─── Performance (backward compat) ────────────────────────────────────────────

@router.get("/performance")
def get_performance(user_id: Optional[int]=None, period: Optional[str]=None,
                    view_type: Optional[str]=None, year: Optional[int]=None,
                    db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    if not period: period=now_ist().strftime("%Y-%m")
    cy=year or int(period[:4]); is_yearly=(view_type=="yearly")
    d_from,d_to=(f"{cy}-01-01",f"{cy}-12-31") if is_yearly else _period_range(period)
    is_agg = cu.role in ADMIN_ROLES and not user_id
    if user_id:
        scope_uids=[_get_visible_uids(cu,db,user_id)[0]]; uid=user_id
    elif is_agg:
        # _get_team_uids: admin/ceo → all users; manager/vp → self + direct reports
        scope_uids = _get_team_uids(cu, db)
        uid=None
    else:
        scope_uids=[cu.id]; uid=cu.id
    act_q=db.query(KAMActivity).filter(KAMActivity.activity_date.between(d_from,d_to))
    if uid: act_q=act_q.filter(KAMActivity.user_id==uid)
    else:   act_q=act_q.filter(KAMActivity.user_id.in_(scope_uids))
    activities=act_q.all()
    def c(atype=None,st=None,acts=None):
        src=acts if acts is not None else activities
        return sum(1 for a in src if (not atype or a.activity_type==atype) and (not st or a.status==st))
    if is_yearly or is_agg:
        tq=db.query(KAMTarget)
        if uid: tq=tq.filter(KAMTarget.user_id==uid,KAMTarget.period.like(f"{cy}-%"))
        else:   tq=tq.filter(KAMTarget.user_id.in_(scope_uids),KAMTarget.period.like(f"{cy}-%"))
        mts=tq.all()
        ct=sum(t.calls_target or 0 for t in mts); mt_=sum(t.meetings_target or 0 for t in mts)
        dt=sum(getattr(t,"demos_target",0) or 0 for t in mts); svt=sum(getattr(t,"site_visits_target",0) or 0 for t in mts)
        st=sum(float(getattr(t,"sales_target",0) or 0) for t in mts)
    else:
        tgt=db.query(KAMTarget).filter(KAMTarget.user_id==uid,KAMTarget.period==period).first()
        ct=tgt.calls_target if tgt else 0; mt_=tgt.meetings_target if tgt else 0
        dt=getattr(tgt,"demos_target",0) if tgt else 0; svt=getattr(tgt,"site_visits_target",0) if tgt else 0
        st=float(getattr(tgt,"sales_target",0) or 0) if tgt else 0
    if uid:
        uo=db.query(User).filter(User.id==uid).first()
        dn=uo.full_name if uo else ""; dr=uo.role if uo else ""
        utv=float(getattr(uo,"target",None) or 0) if uo else 0
        st=st or utv
    else: dn="All Team Members"; dr="team"; utv=0
    ls=_lead_stats(scope_uids if uid is None else [uid],db)
    ts=_tender_stats(scope_uids if uid is None else [uid],db)
    wo=_wo_stats(scope_uids if uid is None else [uid],db)
    actuals={"calls":c("Daily Call","Completed"),"meetings":c("Meeting","Completed"),
             "demos":c("Demo","Completed"),"site_visits":c("Site Visit","Completed"),
             "follow_ups":c("Follow-up","Completed"),"calls_total":c("Daily Call"),
             "meetings_total":c("Meeting"),"demos_total":c("Demo"),
             "site_visits_total":c("Site Visit"),"follow_ups_total":c("Follow-up"),
             "total":len(activities),"completed":c(st="Completed"),
             "pending":c(st="Planned")+c(st="In Progress"),"cancelled":c(st="Cancelled")}
    quarterly=[]
    if is_yearly:
        for qn in range(1,5):
            qf,qt=_quarter_range(cy,qn); q_acts=[a for a in activities if qf<=str(a.activity_date)<=qt]
            qms=[f"{cy}-{(qn-1)*3+m:02d}" for m in range(1,4)]
            qtq=db.query(KAMTarget).filter(KAMTarget.period.in_(qms))
            if uid: qtq=qtq.filter(KAMTarget.user_id==uid)
            else:   qtq=qtq.filter(KAMTarget.user_id.in_(scope_uids))
            qtgs=qtq.all()
            quarterly.append({"quarter":qn,"label":f"Q{qn} {cy}","total":len(q_acts),
                "completed":c(st="Completed",acts=q_acts),"pending":c(st="Planned",acts=q_acts)+c(st="In Progress",acts=q_acts),
                "calls":c("Daily Call","Completed",q_acts),"meetings":c("Meeting","Completed",q_acts),
                "calls_target":sum(t.calls_target or 0 for t in qtgs),
                "meetings_target":sum(t.meetings_target or 0 for t in qtgs)})
    cust_ids=list({a.customer_id for a in activities if a.customer_id}); cb=[]
    for cid in cust_ids:
        cust=db.query(Customer).filter(Customer.id==cid).first()
        ca=[a for a in activities if a.customer_id==cid]
        clq=db.query(Lead).filter(Lead.customer_id==cid,Lead.is_deleted==False)
        ctq=db.query(Tender).filter(Tender.customer_id==cid,Tender.is_deleted==False)
        cwq=db.query(KAMWorkOrder).filter(KAMWorkOrder.customer_id==cid)
        if uid: clq=clq.filter(Lead.assigned_to==uid); ctq=ctq.filter(Tender.assigned_to==uid); cwq=cwq.filter(KAMWorkOrder.user_id==uid)
        else:   clq=clq.filter(Lead.assigned_to.in_(scope_uids)); ctq=ctq.filter(Tender.assigned_to.in_(scope_uids)); cwq=cwq.filter(KAMWorkOrder.user_id.in_(scope_uids))
        cl=clq.all(); ct2=ctq.all(); cw=cwq.all()
        cb.append({"customer_id":cid,"customer_name":cust.customer_name if cust else "",
            "activities":len(ca),"completed":sum(1 for a in ca if a.status=="Completed"),
            "calls":sum(1 for a in ca if a.activity_type=="Daily Call" and a.status=="Completed"),
            "meetings":sum(1 for a in ca if a.activity_type=="Meeting" and a.status=="Completed"),
            "lead_count":len(cl),"lead_value":float(sum(float(l.est_value or 0) for l in cl)),
            "tender_count":len(ct2),"tender_value":float(sum(float(t.est_value or 0) for t in ct2)),
            "work_orders":len(cw),"order_value":float(sum(x.order_value or 0 for x in cw)),
            "payment_received":float(sum(x.payment_received or 0 for x in cw))})
    return {"user_id":uid,"user_name":dn,"user_role":dr,"is_aggregate":is_agg,
            "period":period,"year":cy,"is_yearly":is_yearly,"user_sales_target":utv,"sales_target":st,
            "actuals":actuals,"targets":{"calls":ct,"meetings":mt_,"demos":dt,"site_visits":svt},
            "financials":{"lead_count":ls["lead_count"],"total_lead_value":ls["lead_value"],
                "tender_count":ts["tender_count"],"total_tender_value":ts["tender_value"],
                "order_count":wo["wo_count"],"work_order_count":wo["wo_count"],
                "total_order_value":wo["wo_value"],"payment_received":wo["payment_received"]},
            "quarterly":quarterly,"customer_breakdown":cb,
            "activity_breakdown":{t:sum(1 for a in activities if a.activity_type==t) for t in ACTIVITY_TYPES},
            "recent_activities":[{"id":a.id,"type":a.activity_type,"subject":a.subject,
                "date":str(a.activity_date),"status":a.status,"customer_id":a.customer_id,
                "outcome":_safe_get(a,"outcome"),"user_name":(db.query(User).filter(User.id==a.user_id).first() or User()).full_name if is_agg else ""}
                for a in sorted(activities,key=lambda x:x.activity_date,reverse=True)[:10]]}

