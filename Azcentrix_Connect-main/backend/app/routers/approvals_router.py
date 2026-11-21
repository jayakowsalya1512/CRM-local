"""
Approvals Router — Fixed.

KEY FIX: Added 'travel' module handling in _route_decision().
Previously the travel module had NO case in _route_decision(), so when a manager
approved a travel request via the Approvals screen (POST /approvals/{id}/decide),
the Approval record was marked 'approved' but TravelRequest.status was NEVER updated.
It stayed 'Submitted' forever.

Other fixes:
  - 'tada' (expense_ceo action) also handled in _route_decision for CEO step
  - documents use file_url (not file_path)
  - _ser_product uses tender_product_id for OEM lookup
  - Approval cycle: rejected → resubmit repeats indefinitely
"""

import logging
from datetime import datetime
from app.core.timezone import now_ist, today_ist
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from sqlalchemy import func
from pydantic import BaseModel

from app.core.logging import log_module_action
from app.dependencies import get_tenant_db, get_current_user, get_request_ip
from app.models.all_models import (
    Approval, Tender, TenderProduct, TenderProductOEM, TenderDocument,
    TenderTechBidBidder, TenderTechBidItem, TenderLossAnalysis,
    ApprovalRequest, ApprovalRequestStep,
    Lead, LeadProduct, User, ActivityLog,
    TravelRequest, TADAClaim, TADALineItem, Customer, CustomerContact,
    CustomerBillingConsignee, CustomerShippingConsignee, EMDBG,
    Quotation, QuotationLineItem,
)
from app.services.generic_approval_engine import (
    build_lead_tender_lifecycle_timeline,
    build_tender_lifecycle_timeline,
    decide_generic_approval_request,
    find_pending_request_for_record,
)
from app.services.dynamic_notification_service import emit_notification_event
from app.services.lead_notification_service import dispatch_lead_event_notification
from app.services.notification_service import upsert_notification
from app.services.cache_service import invalidate_badges_cache
from app.services.travel_approval_service import (
    resolve_expired_travel_approvals,
    sync_travel_request_from_generic_approval,
)

logger = logging.getLogger(__name__)
router = APIRouter()

PRIVILEGED_ROLES = ('admin', 'ceo')
MANAGER_ROLES    = ('admin', 'ceo', 'manager', 'vp')


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _notify(db, user_id, title, message, module, record_id, action):
    try:
        upsert_notification(
            db,
            user_id=user_id,
            title=title,
            message=message,
            module=module,
            record_id=record_id,
            action=action,
            category="approval",
            send_email=True,
        )
    except Exception as e:
        logger.warning(f"_notify failed: {e}")


def _emit_tender_event(
    db: Session,
    *,
    tender: Tender,
    event_key: str,
    actor: Optional[User],
    approver_user_id: Optional[int] = None,
    requester_user_id: Optional[int] = None,
    reason: Optional[str] = None,
) -> None:
    try:
        emit_notification_event(
            db,
            module_key="tenders",
            event_key=event_key,
            record_id=tender.id,
            actor_user_id=getattr(actor, "id", None),
            context={
                "tender_num": getattr(tender, "tender_num", "") or "",
                "tender_title": getattr(tender, "tender_title", "") or "",
                "customer_name": getattr(tender, "customer_name", "") or "",
                "assignee_user_id": getattr(tender, "assigned_to", None),
                "approver_user_id": approver_user_id,
                "requester_user_id": requester_user_id,
                "reason": reason or "",
                "record_ref": getattr(tender, "tender_title", "") or "",
            },
        )
    except Exception as exc:
        logger.warning("approvals tender notification failed for tender=%s event=%s: %s", tender.id, event_key, exc)


def _auto_approve_tender_emd(db: Session, tender: Tender) -> None:
    """Auto-approve linked EMD/DD/Online Payment records when step 2 is fully approved."""
    try:
        from sqlalchemy import text as _sa_text
        # Ensure schema columns exist before querying
        try:
            db.execute(_sa_text("ALTER TABLE emdbg ADD COLUMN IF NOT EXISTS `approval_status` VARCHAR(30) NOT NULL DEFAULT 'none'"))
            db.commit()
        except Exception:
            db.rollback()
        emd_recs = db.query(EMDBG).filter(
            EMDBG.tender_id == tender.id,
        ).all()
        for rec in emd_recs:
            if (rec.approval_status or 'none') in ('none', 'pending'):
                rec.approval_status = 'approved'
        db.flush()
    except Exception as exc:
        logger.warning("Failed to auto-approve EMD records for tender %s: %s", tender.id, exc)


def _emit_emdbg_event(
    db: Session,
    *,
    record: EMDBG,
    event_key: str,
    actor: Optional[User],
    approver_user_id: Optional[int] = None,
    requester_user_id: Optional[int] = None,
    reason: Optional[str] = None,
) -> None:
    try:
        emit_notification_event(
            db,
            module_key="emdbg",
            event_key=event_key,
            record_id=record.id,
            actor_user_id=getattr(actor, "id", None),
            context={
                "reference_num": getattr(record, "reference_num", "") or "",
                "instrument_type": getattr(record, "instrument_type", "") or "",
                "amount": getattr(record, "amount", 0) or 0,
                "status": getattr(record, "status", "") or "",
                "creator_user_id": getattr(record, "created_by", None),
                "approver_user_id": approver_user_id,
                "requester_user_id": requester_user_id,
                "reason": reason or "",
                "record_ref": getattr(record, "reference_num", "") or "",
            },
        )
    except Exception as exc:
        logger.warning("approvals emdbg notification failed for record=%s event=%s: %s", record.id, event_key, exc)


def _emit_customer_event(
    db: Session,
    *,
    customer: Customer,
    event_key: str,
    actor: Optional[User],
    approver_user_id: Optional[int] = None,
    requester_user_id: Optional[int] = None,
    reason: Optional[str] = None,
) -> None:
    try:
        emit_notification_event(
            db,
            module_key="customers",
            event_key=event_key,
            record_id=customer.id,
            actor_user_id=getattr(actor, "id", None),
            context={
                "customer_id": customer.id,
                "customer_name": getattr(customer, "customer_name", "") or "",
                "account_status": getattr(customer, "account_status", "") or "",
                "creator_user_id": getattr(customer, "created_by", None),
                "approver_user_id": approver_user_id,
                "requester_user_id": requester_user_id,
                "reason": reason or "",
                "record_ref": getattr(customer, "customer_name", "") or "",
            },
        )
    except Exception as exc:
        logger.warning("approvals customer notification failed for customer=%s event=%s: %s", customer.id, event_key, exc)


def _log(db, user_id, record_id, module, action, description, icon='✅', color='#F0FFF4'):
    try:
        db.add(ActivityLog(
            user_id=user_id, module=module, record_id=record_id,
            action=action, description=description, icon=icon, color=color,
        ))
    except Exception as e:
        logger.warning(f"_log failed: {e}")


def _refresh_travel_auto_approvals(
    db: Session,
    *,
    approval_id: Optional[int] = None,
    approver_id: Optional[int] = None,
    request_id: Optional[int] = None,
):
    resolved = resolve_expired_travel_approvals(
        db,
        approval_id=approval_id,
        approver_id=approver_id,
        request_id=request_id,
    )
    if resolved:
        db.commit()


def _get_shadowed_dynamic_travel_record_ids(
    db: Session,
    *,
    approver_id: Optional[int] = None,
) -> set[int]:
    query = (
        db.query(ApprovalRequest.record_id)
        .join(
            ApprovalRequestStep,
            ApprovalRequestStep.approval_request_id == ApprovalRequest.id,
        )
        .filter(
            ApprovalRequest.module_key == "travel",
            ApprovalRequest.action_key == "request",
            ApprovalRequest.status == "pending",
            ApprovalRequestStep.step_no == ApprovalRequest.current_step_no,
            ApprovalRequestStep.status == "pending",
        )
    )
    if approver_id is not None:
        query = query.filter(ApprovalRequestStep.approver_user_id == approver_id)
    return {
        int(record_id)
        for (record_id,) in query.distinct().all()
        if record_id is not None
    }


def _find_ceo(db: Session) -> Optional[int]:
    for role in ('ceo', 'admin'):
        u = db.query(User).filter(User.role == role, User.is_active == True).first()
        if u:
            return u.id
    return None


def _find_manager(db: Session, assignee_id: int) -> Optional[int]:
    user = db.query(User).filter(User.id == assignee_id).first()
    if user and user.reporting_manager_id:
        return user.reporting_manager_id
    for role in ('manager', 'vp', 'admin', 'ceo'):
        u = db.query(User).filter(User.role == role, User.is_active == True).first()
        if u:
            return u.id
    return None


# ─── Serialize Approval ────────────────────────────────────────────────────────

def _approval_user_map(db: Session, approvals: List[Approval]) -> dict[int, User]:
    user_ids = {
        int(uid)
        for approval in approvals
        for uid in (approval.requested_by, approval.requested_to)
        if uid
    }
    if not user_ids:
        return {}
    return {
        int(user.id): user
        for user in db.query(User).filter(User.id.in_(user_ids)).all()
    }


def _ser_approval(
    a: Approval,
    db: Session,
    include_summary: bool = False,
    user_map: Optional[dict[int, User]] = None,
) -> dict:
    user_map = user_map or {}
    requester = user_map.get(int(a.requested_by)) if a.requested_by else None
    approver = user_map.get(int(a.requested_to)) if a.requested_to else None
    if requester is None and a.requested_by:
        requester = db.query(User).filter(User.id == a.requested_by).first()
    if approver is None and a.requested_to:
        approver = db.query(User).filter(User.id == a.requested_to).first()
    base = {
        'id':                 a.id,
        'module':             a.module,
        'action':             a.action,
        'record_id':          a.record_id,
        'record_ref':         a.record_ref,
        'status':             a.status,
        'requested_by':       a.requested_by,
        'requested_by_name':  requester.full_name if requester else '',
        'requested_to':       a.requested_to,
        'requested_to_name':  approver.full_name if approver else '',
        'request_notes':      a.request_notes,
        'decision_notes':     a.decision_notes,
        'rejection_reason':   a.rejection_reason,
        'decided_at':         str(a.decided_at) if a.decided_at else None,
        'created_at':         str(a.created_at) if a.created_at else None,
        'steps':              [
            {
                'id':               a.id,
                'step_no':          1,
                'approver_user_id': a.requested_to,
                'approver_name':    approver.full_name if approver else None,
                'approver_role':    approver.role if approver else None,
                'status':           a.status,
                'remarks':          a.decision_notes or a.rejection_reason,
                'assigned_at':      str(a.created_at) if a.created_at else None,
                'acted_at':         str(a.decided_at) if a.decided_at else None,
                'escalated_at':     None,
                'escalation_count': 0,
                'resolved_from':    'legacy_approval',
            }
        ],
        'summary':            None,
    }
    if include_summary:
        base['summary'] = _build_summary(a, db)
    return base


# ─── Build rich summary ────────────────────────────────────────────────────────

def _build_summary(a: Approval, db: Session) -> dict:
    if a.module == 'tender':
        return _tender_summary(a, db)
    elif a.module == 'lead':
        return _lead_summary(a, db)
    elif a.module == 'travel':
        return _travel_summary(a, db)
    elif a.module == 'tada':
        return _tada_summary(a, db)
    elif a.module == 'emdbg':
        return _emdbg_summary(a, db)
    elif a.module == 'customer':
        return _customer_summary(a, db)
    elif a.module == 'quotation':
        return _quotation_summary(a, db)
    return {}


def _quotation_summary(a: Approval, db: Session) -> dict:
    q = db.query(Quotation).filter(Quotation.id == a.record_id).first()
    if not q:
        return {'type': 'quotation', 'error': 'Quotation not found'}

    items = (
        db.query(QuotationLineItem)
        .filter(QuotationLineItem.quotation_id == q.id)
        .order_by(QuotationLineItem.sort_order)
        .all()
    )

    # Resolve source title
    source_title = ''
    source_ref   = ''
    if q.lead_id:
        lead = db.query(Lead).filter(Lead.id == q.lead_id).first()
        if lead:
            source_title = lead.lead_title or ''
            source_ref   = lead.lead_ref_id or ''
    elif q.tender_id:
        tender = db.query(Tender).filter(Tender.id == q.tender_id).first()
        if tender:
            source_title = tender.tender_title or ''
            source_ref   = tender.tender_num or ''

    # Resolve customer name
    customer_name = ''
    if q.customer_id:
        cust = db.query(Customer).filter(Customer.id == q.customer_id).first()
        if cust:
            customer_name = cust.customer_name or ''

    return {
        'type':             'quotation',
        'quotation_number': q.quotation_number or '',
        'revision_number':  q.revision_number,
        'subject':          q.subject or '',
        'status':           q.status or '',
        'approval_status':  q.approval_status or 'none',
        'customer_name':    customer_name,
        'source_title':     source_title,
        'source_ref':       source_ref,
        'amount':           float(q.amount or 0),
        'tax_amount':       float(q.tax_amount or 0),
        'total_amount':     float(q.total_amount or 0),
        'valid_until':      str(q.valid_until) if q.valid_until else None,
        'notes':            q.notes or '',
        'terms_conditions': q.terms_conditions or '',
        'line_items': [
            {
                'description': i.description or '',
                'quantity':    float(i.quantity or 1),
                'unit_price':  float(i.unit_price or 0),
                'tax_percent': float(i.tax_percent or 0),
                'line_total':  float(i.line_total or 0),
            }
            for i in items
        ],
    }


def _customer_summary(a: Approval, db: Session) -> dict:
    c = db.query(Customer).filter(Customer.id == a.record_id).first()
    if not c:
        return {'type': 'customer', 'error': 'Customer not found'}

    assigned_user = db.query(User).filter(User.id == c.assigned_to).first() if c.assigned_to else None
    created_by_user = db.query(User).filter(User.id == c.created_by).first() if c.created_by else None

    contacts = db.query(CustomerContact).filter(
        CustomerContact.customer_id == c.id,
        CustomerContact.is_active == True,
    ).order_by(CustomerContact.is_primary.desc()).all()

    billing_consignees = db.query(CustomerBillingConsignee).filter(
        CustomerBillingConsignee.customer_id == c.id
    ).order_by(CustomerBillingConsignee.sort_order).all()

    shipping_consignees = db.query(CustomerShippingConsignee).filter(
        CustomerShippingConsignee.customer_id == c.id
    ).order_by(CustomerShippingConsignee.sort_order).all()

    def _addr(address, area, city, state, pincode, country):
        parts = [p for p in [address, area, city, state, pincode, country] if p]
        return ', '.join(parts) if parts else None

    return {
        'type':             'customer',
        'customer_name':    c.customer_name or '',
        'account_status':   c.account_status or 'Prospect',
        'account_potential': c.account_potential or '',
        'potential_value':  float(c.potential_value) if c.potential_value else None,
        # Account details
        'assigned_to_name': assigned_user.full_name if assigned_user else '',
        'created_by_name':  created_by_user.full_name if created_by_user else '',
        'industry':         c.industry or '',
        'customer_vertical': c.customer_vertical or '',
        'division':         c.division or '',
        'group_name':       c.group_name or '',
        'website':          c.website or '',
        'gst_number':       c.gst_number or '',
        'pan_number':       c.pan_number or '',
        'annual_revenue':   float(c.annual_revenue) if c.annual_revenue else None,
        'employee_count':   int(c.employee_count) if c.employee_count else None,
        'remarks':          c.remarks or '',
        # Billing address
        'billing_address':  _addr(c.billing_address, c.billing_area, c.billing_city, c.billing_state, c.billing_pincode, c.billing_country),
        'billing_city':     c.billing_city or '',
        'billing_state':    c.billing_state or '',
        'billing_pincode':  c.billing_pincode or '',
        'billing_country':  c.billing_country or '',
        # Shipping address
        'shipping_same_as_billing': bool(c.shipping_same_as_billing),
        'shipping_address': _addr(c.shipping_address, c.shipping_area, c.shipping_city, c.shipping_state, c.shipping_pincode, c.shipping_country),
        # Contacts
        'contacts': [
            {
                'contact_name':   ct.contact_name or '',
                'designation':    ct.designation or '',
                'department':     ct.department or '',
                'mobile':         ct.mobile or '',
                'office_phone':   ct.office_phone or '',
                'office_email':   ct.office_email or '',
                'personal_email': ct.personal_email or '',
                'is_primary':     bool(ct.is_primary),
            }
            for ct in contacts
        ],
        # Billing consignees
        'billing_consignees': [
            {
                'name':    bc.name or '',
                'address': ', '.join(filter(None, [bc.address, bc.area, bc.city, bc.state, bc.pincode, bc.country])),
            }
            for bc in billing_consignees
        ],
        # Shipping consignees
        'shipping_consignees': [
            {
                'name':    sc.name or '',
                'address': ', '.join(filter(None, [sc.address, sc.area, sc.city, sc.state, sc.pincode, sc.country])),
            }
            for sc in shipping_consignees
        ],
    }


def _emdbg_summary(a: Approval, db: Session) -> dict:
    e = db.query(EMDBG).filter(EMDBG.id == a.record_id).first()
    if not e:
        return {'type': 'emdbg', 'error': 'EMD/BG record not found'}
    creator = db.query(User).filter(User.id == e.created_by).first() if e.created_by else None
    tender = db.query(Tender).filter(Tender.id == e.tender_id).first() if e.tender_id else None

    def _fmt_date(d):
        return d.isoformat() if d else None

    return {
        'type':               'emdbg',
        'id':                 e.id,                                   # links: Guarantees & Deposits drawer
        'tender_id':          e.tender_id or (tender.id if tender else None),   # links: tender page
        'reference_num':      e.reference_num,
        'instrument_type':    e.instrument_type,
        'amount':             float(e.amount) if e.amount else 0,
        'currency':           e.currency or 'INR',
        'bank_name':          e.bank_name,
        'bank_branch':        e.bank_branch,
        'instrument_number':  e.instrument_number,
        'issued_date':        _fmt_date(e.issued_date),
        'submitted_date':     _fmt_date(e.submitted_date),
        'valid_from':         _fmt_date(e.valid_from),
        'expiry_date':        _fmt_date(e.expiry_date),
        'status':             e.status,
        'approval_status':    e.approval_status,
        'purpose':            e.purpose,
        'notes':              e.notes,
        'client_name':        e.client_name,
        'customer_id':        e.customer_id,
        'tender_num':         e.tender_num or (tender.tender_num if tender else None),
        'tender_title':       tender.tender_title if tender else None,
        'po_number':          e.po_number,
        'po_date':            _fmt_date(e.po_date),
        'wo_value':           float(e.wo_value) if e.wo_value else None,
        'created_by_name':    creator.full_name if creator else None,
        'instrument_document_url': e.instrument_document_url,
        'instrument_file_size_kb': e.instrument_file_size_kb,
    }


def _travel_summary(a: Approval, db: Session) -> dict:
    tr = db.query(TravelRequest).filter(TravelRequest.id == a.record_id).first()
    if not tr:
        return {'type': 'travel', 'error': 'Travel request not found'}
    emp = db.query(User).filter(User.id == tr.employee_id).first()
    customer = db.query(Customer).filter(Customer.id == tr.customer_id).first() if tr.customer_id else None
    lead = db.query(Lead).filter(Lead.id == tr.lead_id).first() if tr.lead_id else None
    tender = db.query(Tender).filter(Tender.id == tr.tender_id).first() if tr.tender_id else None

    def _date(value):
        return str(value) if value else ''

    def _num(value):
        return float(value) if value is not None else None

    tender_label = ''
    if tender:
        tender_label = tender.tender_num or tender.tender_title or f'Tender #{tender.id}'
        if tender.tender_num and tender.tender_title:
            tender_label = f'{tender.tender_num} — {tender.tender_title}'

    return {
        'type':            'travel',
        'request_number':  tr.request_number,
        'employee_name':   emp.full_name if emp else '',
        'purpose':         tr.purpose or '',
        'visit_type':      tr.visit_type or '',
        'account_id':      tr.customer_id,
        'account_name':    (customer.customer_name if customer else '') or (lead.customer_name if lead else '') or (tender.customer_name if tender else ''),
        'lead_id':         tr.lead_id,
        'lead_ref':        (lead.lead_ref_id if lead else '') or (str(tr.lead_id) if tr.lead_id else ''),
        'opportunity_id':  tr.opportunity_id,
        'tender_id':       tr.tender_id,
        'tender_label':    tender_label,
        'contact_name':    tr.contact_name or '',
        'contact_phone':   tr.contact_phone or '',
        'from_city':       tr.from_city or '',
        'to_city':         tr.to_city or '',
        'travel_date':     _date(tr.travel_date),
        'return_date':     _date(tr.return_date),
        'total_days':      tr.total_days or 1,
        'is_outside_district': bool(tr.is_outside_district),
        'transport_mode':  tr.transport_mode or '',
        'vehicle_number':  tr.vehicle_number or '',
        'estimated_kms':   _num(tr.estimated_kms),
        'advance_booking_ref': tr.advance_booking_ref or '',
        'estimated_total': _num(tr.estimated_total),
        'advance_required': bool(tr.advance_required),
        'advance_amount':  _num(tr.advance_amount),
        'cost_center':     tr.cost_center or '',
        'budget_code':     tr.budget_code or '',
        'accommodation_required': bool(tr.accommodation_required),
        'accommodation_type': tr.accommodation_type or '',
        'hotel_name':      tr.hotel_name or '',
        'check_in_date':   _date(tr.check_in_date),
        'check_out_date':  _date(tr.check_out_date),
        'accommodation_cost': _num(tr.accommodation_cost),
        'companions':      tr.companions or '',
        'status':          tr.status or '',
        'notes':           tr.notes or '',
        'source':          getattr(tr, 'source', 'direct'),
        # Include KAM activity subject if sourced from KAM
        'kam_activity_subject': _get_kam_subject(tr, db),
    }


def _get_kam_subject(tr: TravelRequest, db: Session) -> str:
    try:
        kam_act_id = getattr(tr, 'kam_activity_id', None)
        if not kam_act_id:
            return ''
        from app.models.all_models import KAMActivity
        act = db.query(KAMActivity).filter(KAMActivity.id == kam_act_id).first()
        return act.subject if act else ''
    except Exception:
        return ''


def _tada_summary(a: Approval, db: Session) -> dict:
    claim = db.query(TADAClaim).filter(TADAClaim.id == a.record_id).first()
    if not claim:
        return {'type': 'tada', 'error': 'TA/DA claim not found'}
    emp   = db.query(User).filter(User.id == claim.employee_id).first()
    items = db.query(TADALineItem).filter(TADALineItem.claim_id == claim.id).all()
    attachments_by_item: dict[int, list[dict]] = {}
    claim_level_attachments: list[dict] = []
    try:
        from app.models.all_models import TADAAttachment  # type: ignore

        vcols = {c.name for c in TADAAttachment.__table__.columns}
        atts = db.query(TADAAttachment).filter(TADAAttachment.claim_id == claim.id).all()
        for att in atts:
            payload = {
                'id':           att.id,
                'doc_type':     att.doc_type,
                'file_name':    att.file_name,
                'file_path':    att.file_url,
                'file_url':     att.file_url,
                'preview_url':  att.file_url,
                'file_size_kb': getattr(att, 'file_size_kb', None),
                'uploaded_at':  str(att.created_at) if att.created_at else None,
            }
            line_item_id = getattr(att, 'line_item_id', None) if 'line_item_id' in vcols else None
            if 'line_item_id' in vcols and line_item_id:
                attachments_by_item.setdefault(int(line_item_id), []).append(payload)
            else:
                claim_level_attachments.append(payload)
    except Exception as e:
        logger.warning(f'_item_attachments bulk load error: {e}')

    def _item_attachments(item_id: int) -> list:
        if int(item_id) in attachments_by_item:
            return attachments_by_item[int(item_id)]
        if claim_level_attachments:
            return claim_level_attachments
        """Load attachments for a line item — works pre and post migration."""
        try:
            from app.models.all_models import TADAAttachment  # type: ignore
            vcols = {c.name for c in TADAAttachment.__table__.columns}
            if 'line_item_id' in vcols:
                atts = db.query(TADAAttachment).filter(
                    TADAAttachment.line_item_id == item_id
                ).all()
                if not atts:
                    # Fallback: claim-level attachments saved pre-migration
                    atts = db.query(TADAAttachment).filter(
                        TADAAttachment.claim_id == claim.id,
                        TADAAttachment.line_item_id == None,
                    ).all()
            else:
                atts = db.query(TADAAttachment).filter(
                    TADAAttachment.claim_id == claim.id
                ).all()
            return [
                {
                    'id':           att.id,
                    'doc_type':     att.doc_type,
                    'file_name':    att.file_name,
                    'file_path':    att.file_url,
                    'file_url':     att.file_url,
                    'preview_url':  att.file_url,
                    'file_size_kb': getattr(att, 'file_size_kb', None),
                    'uploaded_at':  str(att.created_at) if att.created_at else None,
                }
                for att in atts
            ]
        except Exception as e:
            logger.warning(f'_item_attachments error: {e}')
            return []

    return {
        'type':           'tada',
        'claim_number':   claim.claim_number,
        'employee_name':  emp.full_name if emp else '',
        'purpose':        claim.purpose or '',
        'total_amount':   float(claim.total_amount or 0),
        'advance_taken':  float(claim.advance_taken or 0),
        'net_payable':    float(claim.net_payable   or 0),
        'claim_date':     str(claim.claim_date) if claim.claim_date else '',
        'travel_date_from': str(claim.travel_date_from) if claim.travel_date_from else '',
        'travel_date_to':   str(claim.travel_date_to)   if claim.travel_date_to   else '',
        'overall_status': claim.overall_status,
        'line_items': [
            {
                'id':           i.id,
                'description':  i.description,
                'category':     i.category,
                'amount':       float(i.amount or 0),
                'expense_date': str(i.expense_date) if i.expense_date else '',
                'from_place':   i.from_place or '',
                'to_place':     i.to_place   or '',
                'attachments':  _item_attachments(i.id),
            }
            for i in items
        ],
    }


def _tender_progress_at(t: 'Tender'):
    """Best real timestamp for 'tender processed to next step' — prefers specific
    workflow/business events over the blunt row-level updated_at."""
    if getattr(t, 'step3_approved_at', None):
        return t.step3_approved_at
    if getattr(t, 'submission_date', None):
        return datetime.combine(t.submission_date, datetime.min.time())
    if getattr(t, 'step2_approved_at', None):
        return t.step2_approved_at
    return t.updated_at or t.created_at


def _tender_posted_at(t: 'Tender', db: Session):
    """Best real timestamp for 'Tender Posted' — some tenders have a blank
    created_at at the DB level (schema predates the default), so fall back to
    other real, reliably-populated timestamps tied to the same tender."""
    if t.created_at:
        return t.created_at
    candidates = []
    if getattr(t, 'published_date', None):
        candidates.append(datetime.combine(t.published_date, datetime.min.time()))
    earliest_approval = (
        db.query(Approval.created_at)
        .filter(Approval.module == 'tender', Approval.record_id == t.id)
        .order_by(Approval.created_at.asc())
        .first()
    )
    if earliest_approval and earliest_approval[0]:
        candidates.append(earliest_approval[0])
    return min(candidates) if candidates else t.updated_at


def _tender_summary(a: Approval, db: Session) -> dict:
    t = db.query(Tender).filter(Tender.id == a.record_id).first()
    if not t:
        return {'error': 'Tender not found'}

    assigned_user = db.query(User).filter(User.id == t.assigned_to).first() if t.assigned_to else None

    products = db.query(TenderProduct).filter(
        TenderProduct.tender_id == t.id,
        TenderProduct.is_final_boq == False,
    ).all()
    product_ids = [int(p.id) for p in products if p.id]
    oems_by_product: dict[int, list[TenderProductOEM]] = {}
    if product_ids:
        for oem in db.query(TenderProductOEM).filter(TenderProductOEM.tender_product_id.in_(product_ids)).all():
            oems_by_product.setdefault(int(oem.tender_product_id), []).append(oem)

    def _ser_product(p: TenderProduct) -> dict:
        oems = oems_by_product.get(int(p.id), [])
        return {
            'product_name': p.product_name,
            'quantity':     float(p.quantity or 0),
            'unit_price':   float(p.unit_price or 0),
            'gst_percent':  float(p.gst_percent or 0),
            'is_works_item': bool(p.is_works_item),
            'work_type':    p.work_type or '',
            'work_unit':    p.work_unit or '',
            'work_unit_rate': float(p.work_unit_rate or 0),
            'oems': [
                {
                    'oem_name':        o.oem_name or '',
                    'authorization_num': o.authorization_num or '',
                    'is_preferred':    bool(o.is_preferred),
                } for o in oems
            ],
        }

    fp_rows = db.query(TenderProduct).filter(
        TenderProduct.tender_id == t.id,
        TenderProduct.is_final_boq == True,
    ).all()
    final_products = [
        {
            'product_name':    p.product_name,
            'oem_name':        p.oem_name or '',
            'authorization_num': p.authorization_num or '',
            'quantity':        float(p.quantity or 0),
            'unit_price':      float(p.unit_price or 0),
            'gst_percent':     float(p.gst_percent or 0),
            'total_price':     float(p.total_price or 0),
            'is_works_item':   bool(p.is_works_item),
            'work_type':       p.work_type or '',
        }
        for p in fp_rows
    ]

    docs = db.query(TenderDocument).filter(TenderDocument.tender_id == t.id).all()
    documents = [
        {
            'id':          d.id,
            'doc_type':    d.doc_type,
            'file_name':   d.file_name or '',
            'file_path':   d.file_url,
            'preview_url': d.file_url,
            'file_url':    d.file_url,
            'file_size_kb': d.file_size_kb if hasattr(d, 'file_size_kb') else None,
            'uploaded_at': str(d.created_at) if d.created_at else None,
        }
        for d in docs
    ]

    step1 = {
        'customer_name':    t.customer_name or '',
        'tender_title':     t.tender_title or '',
        'portal_ref_number': t.portal_ref_number or '',
        'est_value':        float(t.est_value) if t.est_value else None,
        'source_portal':    t.source_portal or '',
        'tender_status':    t.tender_status or '',
        'published_date':   str(t.published_date) if t.published_date else None,
        'pre_bid_date':     str(t.pre_bid_date) if t.pre_bid_date else None,
        'submission_date':  str(t.submission_date) if t.submission_date else None,
        'assigned_to_name': assigned_user.full_name if assigned_user else '',
        'rfp_document':     t.rfp_document,
        'products':         [_ser_product(p) for p in products],
    }
    step2 = {
        'tender_fee_required':  bool(t.tender_fee_required),
        'tender_fee_amount':    float(t.tender_fee_amount) if t.tender_fee_amount else None,
        'tender_fee_method':    t.tender_fee_method or '',
        'emd_required':         bool(t.emd_required),
        'emd_amount':           float(t.emd_amount) if t.emd_amount else None,
        'emd_payment_method':   t.emd_payment_method or '',
        'emd_bank_name':        t.emd_bank_name or '',
        'pbg_required':         bool(t.pbg_required),
        'pbg_amount':           float(t.pbg_amount) if t.pbg_amount else None,
        'split_order':          bool(t.split_order),
        'reverse_auction':      bool(t.reverse_auction),
    }
    step3 = None
    if t.corrigendum_document or t.workings_document or final_products:
        step3 = {
            'corrigendum_document': t.corrigendum_document,
            'workings_document':    t.workings_document,
            'final_products':       final_products,
        }

    # Step 4 — Tech bid eligibility
    step4 = None
    if t.tech_bid_eligible:
        bidders = db.query(TenderTechBidBidder).filter(TenderTechBidBidder.tender_id == t.id).order_by(TenderTechBidBidder.sort_order).all()
        bidder_ids = [int(b.id) for b in bidders if b.id]
        items_by_bidder: dict[int, list[TenderTechBidItem]] = {}
        if bidder_ids:
            bid_items = (
                db.query(TenderTechBidItem)
                .filter(TenderTechBidItem.bidder_id.in_(bidder_ids))
                .order_by(TenderTechBidItem.bidder_id, TenderTechBidItem.sort_order)
                .all()
            )
            for item in bid_items:
                items_by_bidder.setdefault(int(item.bidder_id), []).append(item)
        step4 = {
            'tech_bid_eligible': t.tech_bid_eligible,
            'bidders': [
                {
                    'bidder_name': b.bidder_name,
                    'bidder_type': b.bidder_type or '',
                    'items': [
                        {
                            'product_name': i.product_name or '',
                            'oem_name':     i.oem_name or '',
                        }
                        for i in items_by_bidder.get(int(b.id), [])
                    ],
                }
                for b in bidders
            ],
        }

    # Step 5 — Result
    step5 = None
    if t.result:
        loss = db.query(TenderLossAnalysis).filter(TenderLossAnalysis.tender_id == t.id).first()
        step5 = {
            'result':                    t.result or '',
            'result_date':               str(t.result_date) if t.result_date else '',
            'bid_amount':                float(t.bid_amount) if t.bid_amount else None,
            'reverse_auction_final_bid': float(t.reverse_auction_final_bid) if t.reverse_auction_final_bid else None,
            'loss_analysis': {
                'our_position':     loss.our_position or '',
                'competitor_name':  loss.competitor_name or '',
                'competitor_amount': float(loss.competitor_amount) if loss.competitor_amount else None,
                'our_bid_amount':   float(loss.our_bid_amount) if loss.our_bid_amount else None,
                'l1_company':  loss.l1_company or '', 'l1_amount':  float(loss.l1_amount) if loss.l1_amount else None,
                'l2_company':  loss.l2_company or '', 'l2_amount':  float(loss.l2_amount) if loss.l2_amount else None,
                'l3_company':  loss.l3_company or '', 'l3_amount':  float(loss.l3_amount) if loss.l3_amount else None,
                'loss_reason': loss.loss_reason or '',
            } if loss else None,
        }

    step7 = None
    if t.po_num:
        po_docs = [d for d in documents if d['doc_type'] == 'PO Document']
        step7 = {
            'po_num':          t.po_num or '',
            'po_date':         str(t.po_date) if t.po_date else '',
            'po_value':        float(t.po_value) if t.po_value else None,
            'wrnty_mth':       int(t.wrnty_mth) if t.wrnty_mth else None,
            'no_of_consignee': int(t.no_of_consignee) if t.no_of_consignee else None,
            'dlvry_date':      str(t.dlvry_date) if t.dlvry_date else '',
            'site_eng':        t.site_eng or '',
            'eng_phone':       t.eng_phone or '',
            'pmnt_terms':      t.pmnt_terms or '',
            'sow':             t.sow or '',
            'completion_days': int(t.completion_days) if t.completion_days else None,
            'completion_date': str(t.completion_date) if t.completion_date else '',
            'penalty':         bool(t.penalty),
            'ld_type':         t.ld_type or '',
            'ld_percent':      float(t.ld_percent) if t.ld_percent else None,
            'po_documents':    po_docs,
        }

    # Some tenders only carry the link the other way round (Lead.converted_tender_id),
    # e.g. when they were created before the reciprocal Tender.lead_id was backfilled.
    resolved_lead_id = t.lead_id
    if not resolved_lead_id:
        linking_lead = db.query(Lead.id).filter(Lead.converted_tender_id == t.id).first()
        resolved_lead_id = linking_lead[0] if linking_lead else None

    return {
        'type':            'tender',
        'tender_id':       t.id,
        'workflow_status': t.workflow_status or 'draft',
        'current_step':    t.current_step or 1,
        'step1':           step1,
        'step2':           step2,
        'step3':           step3,
        'step4':           step4,
        'step5':           step5,
        'step7':           step7,
        'documents':       documents,
        'tender_timeline': build_tender_lifecycle_timeline(db, t),
    }


def _lead_summary(a: Approval, db: Session) -> dict:
    lead = db.query(Lead).filter(Lead.id == a.record_id).first()
    if not lead:
        return {'error': 'Lead not found'}
    assigned_user = db.query(User).filter(User.id == lead.assigned_to).first() if lead.assigned_to else None
    products = db.query(LeadProduct).filter(LeadProduct.lead_id == lead.id).all()
    return {
        'type':             'lead',
        'lead_id':          lead.id,
        'title':            lead.lead_title,
        'company_name':     lead.customer_name or '',
        'status':           lead.status,
        'assigned_to_name': assigned_user.full_name if assigned_user else '',
        'source':           str(lead.source_id or ''),
        'estimated_value':  float(lead.est_value) if lead.est_value else None,
        'notes':            lead.notes,
        'products': [
            {
                'product_name': p.product_name,
                'oem_name':     getattr(p, 'oem_name', ''),
                'quantity':     float(p.quantity or 0),
            }
            for p in products
        ],
        'tender_timeline':   build_lead_tender_lifecycle_timeline(
            db,
            lead,
            request_created_at=getattr(a, 'created_at', None),
            request_user_id=getattr(a, 'requested_by', None),
        ),
    }


# ─── GET /approvals/pending ────────────────────────────────────────────────────

@router.get("/pending")
def list_pending(
    module: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if module in (None, 'travel'):
        _refresh_travel_auto_approvals(db, approver_id=current_user.id)
    q = db.query(Approval).filter(
        Approval.requested_to == current_user.id,
        Approval.status == 'pending',
    )
    if module:
        q = q.filter(Approval.module == module)
    approvals = q.order_by(Approval.created_at.desc()).all()
    if module in (None, 'travel'):
        shadowed_travel_record_ids = _get_shadowed_dynamic_travel_record_ids(
            db,
            approver_id=current_user.id,
        )
        if shadowed_travel_record_ids:
            approvals = [
                approval
                for approval in approvals
                if approval.module != 'travel' or approval.record_id not in shadowed_travel_record_ids
            ]
    user_map = _approval_user_map(db, approvals)
    return {
        'items': [_ser_approval(a, db, include_summary=False, user_map=user_map) for a in approvals],
        'total': len(approvals),
    }


# ─── GET /approvals/for-record ────────────────────────────────────────────────

@router.get("/for-record")
def get_record_approvals(
    module: str,
    record_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    items = (
        db.query(Approval)
        .filter(Approval.module == module, Approval.record_id == record_id)
        .order_by(Approval.created_at.desc())
        .all()
    )
    user_map = _approval_user_map(db, items)
    return [_ser_approval(a, db, user_map=user_map) for a in items]


# ─── GET /approvals/history ────────────────────────────────────────────────────

@router.get("/history")
def list_history(
    module: Optional[str] = None,
    page: int = 1,
    per_page: int = 20,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if module in (None, 'travel'):
        _refresh_travel_auto_approvals(db)
    q = db.query(Approval).filter(Approval.status != 'pending')
    if current_user.role not in PRIVILEGED_ROLES:
        q = q.filter(
            (Approval.requested_by == current_user.id) |
            (Approval.requested_to == current_user.id)
        )
    if module:
        q = q.filter(Approval.module == module)
    total = q.count()
    items = q.order_by(Approval.decided_at.desc()).offset((page - 1) * per_page).limit(per_page).all()
    user_map = _approval_user_map(db, items)
    return {
        'items':    [_ser_approval(a, db, include_summary=False, user_map=user_map) for a in items],
        'total':    total,
        'page':     page,
        'per_page': per_page,
    }


# ─── GET /approvals/{id}/summary ──────────────────────────────────────────────

@router.get("/{approval_id}/summary")
def get_approval_summary(
    approval_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _refresh_travel_auto_approvals(db, approval_id=approval_id)
    a = db.query(Approval).filter(Approval.id == approval_id).first()
    if not a:
        raise HTTPException(404, "Approval not found")
    if a.requested_to != current_user.id and a.requested_by != current_user.id and current_user.role not in MANAGER_ROLES:
        raise HTTPException(403, "Not authorized to view this approval")
    return _ser_approval(a, db, include_summary=True)


# ─── POST /approvals/{id}/decide ──────────────────────────────────────────────

class DecideIn(BaseModel):
    decision:         str
    notes:            Optional[str] = None
    rejection_reason: Optional[str] = None


@router.post("/{approval_id}/decide")
def decide_approval(
    approval_id: int,
    payload: DecideIn,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _refresh_travel_auto_approvals(db, approval_id=approval_id)
    a = db.query(Approval).filter(Approval.id == approval_id).first()
    if not a:
        raise HTTPException(404, "Approval not found")

    if a.requested_to != current_user.id:
        raise HTTPException(403, "You are not the approver for this request")

    if a.status != 'pending':
        raise HTTPException(400, f"Approval already {a.status}")

    if payload.decision not in ('approved', 'rejected'):
        raise HTTPException(400, "decision must be 'approved' or 'rejected'")

    if payload.decision == 'rejected' and not (payload.rejection_reason or payload.notes or '').strip():
        raise HTTPException(400, "Rejection reason is required")

    a.status           = payload.decision
    a.decision_notes   = payload.notes
    a.rejection_reason = payload.rejection_reason or payload.notes
    a.decided_at       = now_ist()

    debug_data = {
        "approval_id": a.id,
        "module": a.module,
        "action": a.action,
        "decision": payload.decision,
        "record_id": a.record_id,
        "before_route_status": a.status,
    }

    try:
        _route_decision(a, payload.decision, payload.notes or '', db, current_user)
        _log(
            db,
            current_user.id,
            a.record_id,
            a.module,
            f'{a.action}_{payload.decision}',
            f"{a.action} {payload.decision} by {current_user.full_name}",
            'OK' if payload.decision == 'approved' else 'ERR',
            '#F0FFF4' if payload.decision == 'approved' else '#FFF5F5'
        )
        log_module_action(
            db=db, user_id=current_user.id, module=a.module,
            action="approve" if payload.decision == "approved" else "reject",
            record_id=a.record_id, ip=get_request_ip(request),
            description=f"{a.action} {payload.decision} by {current_user.full_name}",
            new_data={"action_key": a.action, "notes": payload.notes, "rejection_reason": a.rejection_reason},
        )
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        logger.exception(
            "Approval decision failed | approval_id=%s module=%s action=%s decision=%s user_id=%s",
            a.id, a.module, a.action, payload.decision, current_user.id,
        )
        raise HTTPException(500, f"Failed to decide approval: {e}") from e

    db.refresh(a)
    res = _ser_approval(a, db, include_summary=True)
    res["debug"] = {
        **debug_data,
        "final_status": a.status,
        "decision_notes": a.decision_notes,
        "rejection_reason": a.rejection_reason,
        "decided_at": str(a.decided_at),
    }
    return res

# ─── Decision routing ──────────────────────────────────────────────────────────

def _route_decision(a: Approval, decision: str, notes: str, db: Session, current_user: User):
    action = a.action
    
    

    # ── TRAVEL REQUEST ─────────────────────────────────────────────────────────
    if a.module == 'travel':
        _handle_travel_decision(a, decision, notes, db, current_user)
        return

    # ── TADA CLAIM (manager step) ──────────────────────────────────────────────
    if a.module == 'tada' and a.action == 'expense':
        _handle_tada_manager_decision(a, decision, notes, db, current_user)
        return

    # ── TADA CLAIM (CEO step) ──────────────────────────────────────────────────
    if a.module == 'tada' and a.action == 'expense_ceo':
        _handle_tada_ceo_decision(a, decision, notes, db, current_user)
        return

    # ── QUOTATION ──────────────────────────────────────────────────────────────
    if a.module == 'quotation':
        q = db.query(Quotation).filter(Quotation.id == a.record_id).first()
        if not q:
            return
        if decision == 'approved':
            q.approval_status = 'approved'
            q.status = 'Accepted'  # directly accepted → unlocks PO tab
            _notify(
                db, a.requested_by,
                f"Quotation {q.quotation_number} Approved",
                f"Your quotation {q.quotation_number} has been approved by {current_user.full_name}.",
                'quotation', q.id, 'approved',
            )
        else:
            q.approval_status = 'rejected'
            _notify(
                db, a.requested_by,
                f"Quotation {q.quotation_number} Rejected",
                f"Your quotation {q.quotation_number} was rejected by {current_user.full_name}. Reason: {notes or 'No reason provided'}",
                'quotation', q.id, 'rejected',
            )
        _log(
            db, current_user.id, q.id, 'quotation',
            f'approval_{decision}',
            f"Quotation {q.quotation_number} {decision} by {current_user.full_name}",
        )
        return

    # ── EMD / BG ───────────────────────────────────────────────────────────────
    if a.module == 'emdbg':
        e = db.query(EMDBG).filter(EMDBG.id == a.record_id).first()
        if not e:
            return
        e.approval_status = decision
        if decision == 'approved':
            _emit_emdbg_event(
                db,
                record=e,
                event_key='approved',
                actor=current_user,
                approver_user_id=a.requested_to,
                requester_user_id=a.requested_by,
            )
        else:
            _emit_emdbg_event(
                db,
                record=e,
                event_key='rejected',
                actor=current_user,
                approver_user_id=a.requested_to,
                requester_user_id=a.requested_by,
                reason=notes,
            )
        _log(
            db, current_user.id, e.id, 'emdbg',
            f'approval_{decision}',
            f"EMD/BG {e.reference_num} {decision} by {current_user.full_name}",
        )
        return

    # ── Tender Step-2 Manager ──────────────────────────────────────────────────
    if action == 'tender_step2_manager':
        t = db.query(Tender).filter(Tender.id == a.record_id).first()
        if not t:
            return
        if decision == 'approved':
            existing_ceo = db.query(Approval).filter(
                Approval.module    == 'tender',
                Approval.record_id == t.id,
                Approval.action    == 'tender_step2_ceo',
                Approval.status    == 'pending',
            ).first()
            if existing_ceo:
                t.step2_approval_id = existing_ceo.id
                t.workflow_status = 'pending_ceo'
                return

            ceo_id = _find_ceo(db)
            if ceo_id and ceo_id != current_user.id:
                new_a = Approval(
                    module='tender', action='tender_step2_ceo',
                    record_id=t.id, record_ref=a.record_ref,
                    requested_by=a.requested_by, requested_to=ceo_id,
                    status='pending', request_notes=f"Manager approved. {notes}",
                )
                db.add(new_a)
                db.flush()
                t.step2_approval_id = new_a.id
                t.workflow_status   = 'pending_ceo'
                _emit_tender_event(
                    db,
                    tender=t,
                    event_key='step2_approval_requested',
                    actor=current_user,
                    approver_user_id=ceo_id,
                    requester_user_id=a.requested_by,
                )
            else:
                t.workflow_status    = 'active'
                t.listed_in_accounts = True
                if hasattr(t, 'step2_approved_at'):
                    t.step2_approved_at = now_ist()
                _auto_approve_tender_emd(db, t)
                _emit_tender_event(
                    db,
                    tender=t,
                    event_key='step2_approved',
                    actor=current_user,
                )
        else:
            t.workflow_status = 'rejected'
            _emit_tender_event(
                db,
                tender=t,
                event_key='step2_rejected',
                actor=current_user,
                reason=notes,
            )

    # ── Tender Step-2 CEO ──────────────────────────────────────────────────────
    elif action == 'tender_step2_ceo':
        t = db.query(Tender).filter(Tender.id == a.record_id).first()
        if not t:
            return
        if decision == 'approved':
            t.workflow_status    = 'active'
            t.listed_in_accounts = True
            if hasattr(t, 'step2_approved_at'):
                t.step2_approved_at = now_ist()
            _auto_approve_tender_emd(db, t)
            _emit_tender_event(
                db,
                tender=t,
                event_key='step2_approved',
                actor=current_user,
            )
        else:
            t.workflow_status = 'rejected'
            _emit_tender_event(
                db,
                tender=t,
                event_key='step2_rejected',
                actor=current_user,
                reason=notes,
            )

    # ── Tender Step-3 Manager ──────────────────────────────────────────────────
    elif action == 'tender_step3_manager':
        t = db.query(Tender).filter(Tender.id == a.record_id).first()
        if not t:
            return
        if decision == 'approved':
            existing_ceo = db.query(Approval).filter(
                Approval.module    == 'tender',
                Approval.record_id == t.id,
                Approval.action    == 'tender_step3_ceo',
                Approval.status    == 'pending',
            ).first()
            if existing_ceo:
                t.step3_approval_id = existing_ceo.id
                t.workflow_status = 'step3_pending'
                return

            ceo_id = _find_ceo(db)
            if ceo_id and ceo_id != current_user.id:
                new_a = Approval(
                    module='tender', action='tender_step3_ceo',
                    record_id=t.id, record_ref=a.record_ref,
                    requested_by=a.requested_by, requested_to=ceo_id,
                    status='pending', request_notes=f"Manager approved Workings. {notes}",
                )
                db.add(new_a)
                db.flush()
                t.step3_approval_id = new_a.id
                t.workflow_status   = 'step3_pending'
                _emit_tender_event(
                    db,
                    tender=t,
                    event_key='step3_approval_requested',
                    actor=current_user,
                    approver_user_id=ceo_id,
                    requester_user_id=a.requested_by,
                )
            else:
                t.workflow_status    = 'step3_active'
                t.tender_status      = 'Submitted'
                t.listed_in_accounts = True
                if hasattr(t, 'step3_approved_at'):
                    t.step3_approved_at = now_ist()
                _emit_tender_event(
                    db,
                    tender=t,
                    event_key='step3_approved',
                    actor=current_user,
                )
                _emit_tender_event(
                    db,
                    tender=t,
                    event_key='submitted',
                    actor=current_user,
                )
        else:
            t.workflow_status = 'active'
            _emit_tender_event(
                db,
                tender=t,
                event_key='step3_rejected',
                actor=current_user,
                reason=notes,
            )

    # ── Tender Step-3 CEO ──────────────────────────────────────────────────────
    elif action == 'tender_step3_ceo':
        t = db.query(Tender).filter(Tender.id == a.record_id).first()
        if not t:
            return
        if decision == 'approved':
            t.workflow_status    = 'step3_active'
            t.tender_status      = 'Submitted'
            t.listed_in_accounts = True
            if hasattr(t, 'step3_approved_at'):
                t.step3_approved_at = now_ist()
            _emit_tender_event(
                db,
                tender=t,
                event_key='step3_approved',
                actor=current_user,
            )
            _emit_tender_event(
                db,
                tender=t,
                event_key='submitted',
                actor=current_user,
            )
        else:
            t.workflow_status = 'active'
            _emit_tender_event(
                db,
                tender=t,
                event_key='step3_rejected',
                actor=current_user,
                reason=notes,
            )

    # ── Tender PO Details (Manager) ───────────────────────────────────────────
    elif action == 'tender_po_manager':
        t = db.query(Tender).filter(Tender.id == a.record_id).first()
        if not t:
            return
        if decision == 'approved':
            t.po_workflow_status = 'approved'
            # Auto-create PBG EMDBG record if PBG data is present
            if getattr(t, 'pbg_required', False) and getattr(t, 'pbg_expiry_date', None):
                try:
                    existing = db.query(EMDBG).filter(
                        EMDBG.tender_id == t.id,
                        EMDBG.instrument_type == 'Performance BG',
                    ).first()
                    if existing is None:
                        count = db.query(EMDBG).count() or 0
                        from datetime import datetime as _dt
                        ref_num = f"EMDBG-{_dt.now().strftime('%Y%m')}-{count + 1:04d}"
                        pbg_rec = EMDBG(
                            reference_num     = ref_num,
                            tender_num        = t.tender_num or "",
                            tender_id         = t.id,
                            client_name       = t.customer_name or "",
                            customer_id       = t.customer_id,
                            instrument_type   = 'Performance BG',
                            amount            = float(t.pbg_amount) if getattr(t, 'pbg_amount', None) else 0,
                            bank_name         = getattr(t, 'pbg_bank_name', None),
                            bank_branch       = getattr(t, 'pbg_bank_branch', None),
                            instrument_number = getattr(t, 'pbg_instrument_number', None),
                            issued_date       = getattr(t, 'pbg_issued_date', None),
                            submitted_date    = getattr(t, 'pbg_submitted_date', None),
                            valid_from        = getattr(t, 'pbg_valid_from', None),
                            expiry_date       = t.pbg_expiry_date,
                            purpose           = getattr(t, 'pbg_purpose', None),
                            status            = 'Active',
                            approval_status   = 'none',
                            created_by        = current_user.id,
                        )
                        db.add(pbg_rec)
                        db.flush()
                        t.pbg_emdbg_id = pbg_rec.id
                    else:
                        if getattr(t, 'pbg_amount', None):
                            existing.amount = float(t.pbg_amount)
                        for attr, col in [
                            ('pbg_bank_name', 'bank_name'), ('pbg_bank_branch', 'bank_branch'),
                            ('pbg_instrument_number', 'instrument_number'),
                            ('pbg_issued_date', 'issued_date'), ('pbg_submitted_date', 'submitted_date'),
                            ('pbg_valid_from', 'valid_from'), ('pbg_expiry_date', 'expiry_date'),
                            ('pbg_purpose', 'purpose'),
                        ]:
                            val = getattr(t, attr, None)
                            if val:
                                setattr(existing, col, val)
                        db.flush()
                        t.pbg_emdbg_id = existing.id
                except Exception as exc:
                    logger.warning("PBG EMDBG auto-create failed on PO approval: %s", exc)
            _emit_tender_event(
                db,
                tender=t,
                event_key='po_approved',
                actor=current_user,
            )
        else:
            t.po_workflow_status = 'draft'
            _emit_tender_event(
                db,
                tender=t,
                event_key='po_rejected',
                actor=current_user,
                reason=notes,
            )

    # ── Lead Conversion (Manager) ──────────────────────────────────────────────
    elif action == 'convert':
        lead = db.query(Lead).filter(Lead.id == a.record_id).first()
        if not lead:
            return
        if decision == 'approved':
            lead.status          = 'Converted'
            lead.approval_status = 'approved'
            lead.converted_at    = now_ist()
            _convert_lead_to_tender(lead, db, current_user)
            try:
                dispatch_lead_event_notification(
                    db,
                    lead=lead,
                    event_key="status_won",
                    title="Lead Won",
                    message=f"Lead '{lead.lead_title}' was converted to Tender by {current_user.full_name}.",
                    actor_user_id=current_user.id,
                )
            except Exception as exc:
                logger.warning("lead event notification failed for approval lead=%s: %s", lead.id, exc)
        else:
            lead.status           = 'Opportunity Created'
            lead.approval_status  = 'rejected'
            lead.rejection_reason = notes
            _notify(db, lead.assigned_to or 0,
                    "Lead Conversion Rejected — Please Revise",
                    f"Manager rejected conversion: {notes}. Please update and re-submit.",
                    'lead', lead.id, 'rejected')

    # ── Customer Creation ──────────────────────────────────────────────────────
    elif action == 'create' and a.module == 'customer':
        customer = db.query(Customer).filter(Customer.id == a.record_id).first()
        if not customer:
            return
        if decision == 'approved':
            customer.is_active       = True
            customer.approval_status = 'approved'
            _emit_customer_event(
                db,
                customer=customer,
                event_key="approved",
                actor=current_user,
                approver_user_id=current_user.id,
                requester_user_id=customer.created_by,
            )
        else:
            customer.approval_status = 'rejected'
            _emit_customer_event(
                db,
                customer=customer,
                event_key="rejected",
                actor=current_user,
                approver_user_id=current_user.id,
                requester_user_id=customer.created_by,
                reason=notes,
            )


# ─── Travel decision handler ──────────────────────────────────────────────────

def _handle_travel_decision(
    a: Approval, decision: str, notes: str,
    db: Session, current_user: User,
):
    """
    THE KEY FIX: This function was missing entirely.
    When a manager approves/rejects a travel request via the Approvals screen,
    this updates TravelRequest.status so it actually reflects the decision.
    """
    from datetime import timezone
    tr = db.query(TravelRequest).filter(TravelRequest.id == a.record_id).first()
    if not tr:
        logger.warning(f"TravelRequest {a.record_id} not found for approval {a.id}")
        return

    pending_request = find_pending_request_for_record(
        db,
        module_key="travel",
        action_key="request",
        record_id=tr.id,
    )
    if pending_request:
        updated_request = decide_generic_approval_request(
            db,
            approval_request_id=pending_request.id,
            approver=current_user,
            decision=decision,
            remarks=notes,
        )
        sync_travel_request_from_generic_approval(
            db,
            approval_request=updated_request,
            actor=current_user,
            remarks=notes,
        )
        return

    if decision == 'approved':
        tr.status     = 'Approved'
        tr.approved_by = current_user.id
        tr.approved_at = now_ist()
        _notify(
            db, tr.employee_id,
            title     = f"Travel Request Approved: {tr.request_number}",
            message   = f"Your travel request to {tr.to_city} has been approved by {current_user.full_name}.",
            module    = 'travel',
            record_id = tr.id,
            action    = 'approved',
        )
    else:
        tr.status           = 'Rejected'
        tr.rejection_reason = a.rejection_reason or notes
        _notify(
            db, tr.employee_id,
            title     = f"Travel Request Rejected: {tr.request_number}",
            message   = (
                f"Rejected by {current_user.full_name}. "
                f"Reason: {a.rejection_reason or notes or '—'}. "
                "Please revise and re-submit."
            ),
            module    = 'travel',
            record_id = tr.id,
            action    = 'rejected',
        )


# ─── TADA manager decision handler ────────────────────────────────────────────

def _handle_tada_manager_decision(
    a: Approval, decision: str, notes: str,
    db: Session, current_user: User,
):
    from datetime import timezone
    claim = db.query(TADAClaim).filter(TADAClaim.id == a.record_id).first()
    if not claim:
        return

    if decision == 'approved':
        claim.manager_status      = 'approved'
        claim.manager_approved_by = current_user.id
        claim.manager_approved_at = now_ist()

        # Escalate to CEO
        ceo_id = _find_ceo(db)
        if ceo_id:
            ceo_appr = Approval(
                module        = 'tada',
                action        = 'expense_ceo',
                record_id     = claim.id,
                record_ref    = f"{claim.claim_number} (₹{claim.net_payable:,.2f})",
                requested_by  = claim.employee_id,
                requested_to  = ceo_id,
                status        = 'pending',
                request_notes = f"Manager approved. {notes}".strip(),
            )
            db.add(ceo_appr)
            db.flush()
            claim.overall_status = 'Manager Approved'
            requester = db.query(User).filter(User.id == claim.employee_id).first()
            _notify(db, ceo_id,
                    f"TA/DA Needs CEO Approval: {claim.claim_number}",
                    f"Manager approved {requester.full_name if requester else ''}'s "
                    f"TA/DA of ₹{claim.net_payable:,.2f}. Awaiting CEO review.",
                    'tada', claim.id, 'ceo_approval_request')
            _notify(db, claim.employee_id,
                    f"TA/DA Manager Approved: {claim.claim_number}",
                    "Your TA/DA claim has been approved by your manager and sent to CEO.",
                    'tada', claim.id, 'manager_approved')
        else:
            claim.overall_status = 'CEO Approved'
            _notify_accounts_tada(db, claim)
    else:
        claim.manager_status           = 'rejected'
        claim.manager_rejection_reason = a.rejection_reason or notes
        claim.overall_status           = 'Rejected'
        _notify(db, claim.employee_id,
                f"TA/DA Rejected by Manager: {claim.claim_number}",
                f"Reason: {a.rejection_reason or notes or '—'}. Please revise and re-submit.",
                'tada', claim.id, 'manager_rejected')


# ─── TADA CEO decision handler ────────────────────────────────────────────────

def _handle_tada_ceo_decision(
    a: Approval, decision: str, notes: str,
    db: Session, current_user: User,
):
    claim = db.query(TADAClaim).filter(TADAClaim.id == a.record_id).first()
    if not claim:
        return

    if decision == 'approved':
        claim.overall_status = 'CEO Approved'
        _notify_accounts_tada(db, claim)
        _notify(db, claim.employee_id,
                f"TA/DA CEO Approved: {claim.claim_number}",
                "CEO approved your TA/DA claim. Payment will be processed by Accounts.",
                'tada', claim.id, 'ceo_approved')
    else:
        claim.overall_status = 'Rejected'
        _notify(db, claim.employee_id,
                f"TA/DA Rejected by CEO: {claim.claim_number}",
                f"CEO rejected: {a.rejection_reason or notes or '—'}. Please revise and re-submit.",
                'tada', claim.id, 'ceo_rejected')


def _notify_accounts_tada(db: Session, claim: TADAClaim):
    requester = db.query(User).filter(User.id == claim.employee_id).first()
    for au in db.query(User).filter(User.role == 'accounts', User.is_active == True).all():
        _notify(
            db, au.id,
            f"TA/DA Ready for Payment: {claim.claim_number}",
            f"CEO approved {requester.full_name if requester else ''}'s "
            f"TA/DA of ₹{claim.net_payable:,.2f}. Awaiting payment.",
            'tada', claim.id, 'accounts_notify',
        )


def _convert_lead_to_tender(lead: 'Lead', db: Session, current_user: User):
    t = Tender(
        customer_name      = lead.customer_name or lead.lead_title,
        tender_title       = f"Tender: {lead.lead_title}",
        assigned_to        = lead.assigned_to,
        created_by         = current_user.id,
        source_id          = lead.source_id,
        workflow_status    = 'draft',
        current_step       = 1,
        listed_in_accounts = False,
        tender_status      = 'Aligned',
    )
    db.add(t)
    db.flush()
    products = db.query(LeadProduct).filter(LeadProduct.lead_id == lead.id).all()
    for p in products:
        db.add(TenderProduct(
            tender_id    = t.id,
            product_name = p.product_name,
            quantity     = p.quantity or 1,
            is_final_boq = False,
        ))
    lead.converted_tender_id = t.id


# ─── Badge / mark-seen ────────────────────────────────────────────────────────

@router.get("/badge")
def get_approvals_badge(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _refresh_travel_auto_approvals(db, approver_id=cu.id)
    shadowed_travel_record_ids = _get_shadowed_dynamic_travel_record_ids(
        db,
        approver_id=cu.id,
    )
    legacy_query = db.query(Approval).filter(
        Approval.requested_to == cu.id,
        Approval.status == 'pending',
    )
    legacy_approvals = legacy_query.all()
    if shadowed_travel_record_ids:
        legacy_approvals = [
            approval
            for approval in legacy_approvals
            if approval.module != 'travel' or approval.record_id not in shadowed_travel_record_ids
        ]
    legacy_count = len(legacy_approvals)
    dynamic_count = (
        db.query(func.count(ApprovalRequest.id))
        .join(
            ApprovalRequestStep,
            ApprovalRequestStep.approval_request_id == ApprovalRequest.id,
        )
        .filter(
            ApprovalRequest.status == 'pending',
            ApprovalRequestStep.step_no == ApprovalRequest.current_step_no,
            ApprovalRequestStep.approver_user_id == cu.id,
            ApprovalRequestStep.status == 'pending',
        )
        .scalar()
        or 0
    )
    return {"count": int(legacy_count) + int(dynamic_count)}


@router.post("/mark-seen")
def mark_approvals_seen(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    invalidate_badges_cache(db, cu.id)
    return {"ok": True}

