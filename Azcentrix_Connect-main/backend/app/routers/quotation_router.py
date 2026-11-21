"""
quotation_router.py — read-only quotation API (one row per revision) kept for the modules that link to quotations
=================================================================================================================
The Quotes module (prototype v17) lives in quotes_router.py / quote_service.py (/api/v1/quotes): creating quotes,
revisions, line items, stage moves, approvals, PDF and work-order conversion all go through it, so revision locking
and approval gates cannot be bypassed here.

Endpoints (Reports drill-downs, Record view):
  GET    /quotations/all                  → list quotation revisions (filters: tender_id, lead_id, customer_id)
  GET    /quotations/by-lead/{lead_id}    → all revisions for a lead
  GET    /quotations/{id}                 → one revision

Helpers used elsewhere: _ensure_quotation_runtime_schema (Correspondence, Quotes), _next_quotation_number (Quotes,
tenant data migration).
"""

import logging
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text, inspect

from app.core.timezone import now_ist
from app.dependencies import get_tenant_db, require_permission
from app.utils.data_scope import apply_data_scope
from app.models.all_models import Quotation, QuotationLineItem, Lead, Tender, Letter, User, ApprovalRequest, ApprovalRequestStep

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Runtime schema safety ───────────────────────────────────────────────────

def _ensure_quotation_runtime_schema(db: Session) -> None:
    """
    Keeps older tenant databases compatible with current quotation letter-pad fields.
    Safe to run repeatedly.
    """
    try:
        inspector = inspect(db.get_bind())
        if "quotations" not in inspector.get_table_names():
            return

        columns = {col["name"] for col in inspector.get_columns("quotations")}
        statements: list[str] = []

        # Existing letter-pad fields used by frontend
        if "ref_number" not in columns:
            statements.append("ALTER TABLE quotations ADD COLUMN `ref_number` VARCHAR(100) NULL")
        if "customer_to_name" not in columns:
            statements.append("ALTER TABLE quotations ADD COLUMN `customer_to_name` VARCHAR(255) NULL")
        if "customer_address_text" not in columns:
            statements.append("ALTER TABLE quotations ADD COLUMN `customer_address_text` TEXT NULL")
        if "greeting_text" not in columns:
            statements.append("ALTER TABLE quotations ADD COLUMN `greeting_text` TEXT NULL")
        if "signatory_user_id" not in columns:
            statements.append("ALTER TABLE quotations ADD COLUMN `signatory_user_id` INT NULL")
        if "company_name_override" not in columns:
            statements.append("ALTER TABLE quotations ADD COLUMN `company_name_override` VARCHAR(255) NULL")
        if "company_address_override" not in columns:
            statements.append("ALTER TABLE quotations ADD COLUMN `company_address_override` TEXT NULL")

        # New selected company address fields
        if "company_address_id" not in columns:
            statements.append("ALTER TABLE quotations ADD COLUMN `company_address_id` INT NULL")
        if "company_address_text" not in columns:
            statements.append("ALTER TABLE quotations ADD COLUMN `company_address_text` TEXT NULL")

        # Approval fields used by approval workflow
        if "approval_status" not in columns:
            statements.append("ALTER TABLE quotations ADD COLUMN `approval_status` VARCHAR(30) NULL DEFAULT 'none'")
        if "approval_id" not in columns:
            statements.append("ALTER TABLE quotations ADD COLUMN `approval_id` INT NULL")
        if "letter_id" not in columns:
            statements.append("ALTER TABLE quotations ADD COLUMN `letter_id` INT NULL")

        for statement in statements:
            db.execute(text(statement))

        if statements:
            db.commit()
            logger.info("Quotation runtime schema updated: %s", ", ".join(statements))

    except Exception as exc:
        db.rollback()
        logger.warning("Quotation runtime schema sync skipped: %s", exc)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _next_quotation_number(db: Session) -> str:
    """Generate QT-YYMM-NNNN sequential across all quotations."""
    prefix = f"QT-{now_ist().strftime('%y%m')}-"
    row = db.execute(
        text(
            "SELECT MAX(CAST(SUBSTRING(quotation_number, :offset) AS UNSIGNED)) "
            "FROM quotations WHERE quotation_number LIKE :p"
        ),
        {"p": f"{prefix}%", "offset": len(prefix) + 1},
    ).fetchone()
    seq = (row[0] or 0) + 1
    return f"{prefix}{seq:04d}"


def _serialize(
    q: Quotation,
    items: list,
    db: Session = None,
    *,
    user_map: Optional[dict[int, User]] = None,
    rejection_reason_map: Optional[dict[int, Optional[str]]] = None,
) -> dict:
    user_map = user_map or {}
    signatory = None
    signatory_user_id = getattr(q, "signatory_user_id", None)
    if signatory_user_id:
        signatory = user_map.get(int(signatory_user_id))
        if signatory is None and db:
            signatory = db.query(User).filter(User.id == signatory_user_id).first()
    elif db and getattr(q, "created_by", None):
        created_by = int(q.created_by)
        signatory = user_map.get(created_by)
        if signatory is None:
            signatory = db.query(User).filter(User.id == q.created_by).first()

    created_by_id = getattr(q, "created_by", None)
    creator = signatory if (created_by_id and not signatory_user_id) else None
    if creator is None and created_by_id:
        creator = user_map.get(int(created_by_id))
        if creator is None and db:
            creator = db.query(User).filter(User.id == created_by_id).first()

    rejection_reason = None
    approval_id = getattr(q, "approval_id", None)
    if approval_id and rejection_reason_map is not None:
        rejection_reason = rejection_reason_map.get(int(approval_id))
    elif db and approval_id:
        # approval_id points to ApprovalRequest (generic engine); find rejected step's remarks
        ar = db.query(ApprovalRequest).filter(ApprovalRequest.id == approval_id).first()
        if ar:
            rejected_step = (
                db.query(ApprovalRequestStep)
                .filter(
                    ApprovalRequestStep.approval_request_id == ar.id,
                    ApprovalRequestStep.status == "rejected",
                )
                .order_by(ApprovalRequestStep.step_no.desc())
                .first()
            )
            if rejected_step and rejected_step.remarks:
                rejection_reason = rejected_step.remarks

    return {
        "id": q.id,
        "lead_id": q.lead_id,
        "tender_id": getattr(q, "tender_id", None),
        "letter_id": getattr(q, "letter_id", None),
        "source_type": "letter" if getattr(q, "letter_id", None) else ("tender" if getattr(q, "tender_id", None) else "opportunity"),
        "issued_from_letter": bool(getattr(q, "letter_id", None)),
        "customer_id": q.customer_id,
        "quotation_number": q.quotation_number,
        "revision_number": q.revision_number,
        "revision_label": f"Q{q.revision_number}",
        "subject": q.subject or "",
        "amount": float(q.amount or 0),
        "tax_amount": float(q.tax_amount or 0),
        "total_amount": float(q.total_amount or 0),
        "valid_until": str(q.valid_until) if q.valid_until else None,
        "status": q.status,
        "notes": q.notes or "",
        "terms_conditions": q.terms_conditions or "",

        # Letter-pad fields
        "ref_number": getattr(q, "ref_number", None) or "",
        "customer_to_name": getattr(q, "customer_to_name", None) or "",
        "customer_address_text": getattr(q, "customer_address_text", None) or "",
        "greeting_text": getattr(q, "greeting_text", None) or "",
        "signatory_user_id": getattr(q, "signatory_user_id", None),
        "company_name_override": getattr(q, "company_name_override", None) or "",
        "company_address_override": getattr(q, "company_address_override", None) or "",

        # New selected company address fields
        "company_address_id": getattr(q, "company_address_id", None),
        "company_address_text": getattr(q, "company_address_text", None) or "",

        "signatory": {
            "full_name": signatory.full_name if signatory else "",
            "designation": getattr(signatory, "designation", "") if signatory else "",
            "phone": getattr(signatory, "phone", "") if signatory else "",
            "email": getattr(signatory, "email", "") if signatory else "",
        },
        "approval_status": getattr(q, "approval_status", None) or "none",
        "approval_id": getattr(q, "approval_id", None),
        "rejection_reason": rejection_reason,
        "created_by": q.created_by,
        "created_by_name": creator.full_name if creator else "",
        "created_at": q.created_at.isoformat() if q.created_at else None,
        "updated_at": q.updated_at.isoformat() if q.updated_at else None,
        "line_items": [
            {
                "id": i.id,
                "description": i.description,
                "quantity": float(i.quantity or 1),
                "unit_price": float(i.unit_price or 0),
                "tax_percent": float(i.tax_percent or 0),
                "discount_percent": float(getattr(i, "discount_percent", 0) or 0),
                "net_price": float(getattr(i, "net_price", 0) or 0),
                "gst_value": float(getattr(i, "gst_value", 0) or 0),
                "line_total": float(i.line_total or 0),
                "sort_order": i.sort_order or 0,
            }
            for i in items
        ],
    }


def _scope_quotations(db: Session, query, user: User):
    """Restrict *query* to the user's configured Data Visibility for quotations
    (owner = created_by, assignee = signatory)."""
    return apply_data_scope(db, query, user, "quotations", Quotation.created_by, Quotation.signatory_user_id)


def _get_or_404(db: Session, quotation_id: int, user: Optional[User] = None) -> Quotation:
    query = db.query(Quotation).filter(Quotation.id == quotation_id)
    if user is not None:
        query = _scope_quotations(db, query, user)
    q = query.first()
    if not q:
        raise HTTPException(404, f"Quotation id={quotation_id} not found")
    return q


def _line_items_by_quotation(db: Session, quotation_ids: list[int]) -> dict[int, list[QuotationLineItem]]:
    if not quotation_ids:
        return {}
    rows = (
        db.query(QuotationLineItem)
        .filter(QuotationLineItem.quotation_id.in_(quotation_ids))
        .order_by(QuotationLineItem.quotation_id.asc(), QuotationLineItem.sort_order.asc(), QuotationLineItem.id.asc())
        .all()
    )
    grouped: dict[int, list[QuotationLineItem]] = defaultdict(list)
    for row in rows:
        grouped[int(row.quotation_id)].append(row)
    return grouped


def _quotation_user_map(db: Session, quotations: list[Quotation]) -> dict[int, User]:
    user_ids = {
        int(user_id)
        for quotation in quotations
        for user_id in (getattr(quotation, "signatory_user_id", None), getattr(quotation, "created_by", None))
        if user_id
    }
    return {
        int(user.id): user
        for user in db.query(User).filter(User.id.in_(user_ids)).all()
    } if user_ids else {}


def _quotation_rejection_reason_map(db: Session, quotations: list[Quotation]) -> dict[int, Optional[str]]:
    approval_request_ids = {
        int(quotation.approval_id)
        for quotation in quotations
        if getattr(quotation, "approval_id", None)
    }
    if not approval_request_ids:
        return {}
    rows = (
        db.query(
            ApprovalRequestStep.approval_request_id,
            ApprovalRequestStep.remarks,
        )
        .filter(
            ApprovalRequestStep.approval_request_id.in_(approval_request_ids),
            ApprovalRequestStep.status == "rejected",
        )
        .order_by(
            ApprovalRequestStep.approval_request_id.asc(),
            ApprovalRequestStep.step_no.desc(),
            ApprovalRequestStep.id.desc(),
        )
        .all()
    )
    reason_map: dict[int, Optional[str]] = {}
    for approval_request_id, remarks in rows:
        reason_map.setdefault(int(approval_request_id), remarks)
    return reason_map


# ─── GET /quotations/all ─────────────────────────────────────────────────────

@router.get("/all")
def list_all(
    tender_id: Optional[int] = None,
    lead_id: Optional[int] = None,
    customer_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("quotations.view")),
):
    _ensure_quotation_runtime_schema(db)

    q_base = _scope_quotations(db, db.query(Quotation), cu)
    if tender_id:
        q_base = q_base.filter(Quotation.tender_id == tender_id)
    if lead_id:
        q_base = q_base.filter(Quotation.lead_id == lead_id)
    if customer_id:
        q_base = q_base.filter(Quotation.customer_id == customer_id)

    quotations = (
        q_base
        .order_by(Quotation.created_at.desc())
        .all()
    )
    lead_ids = {q.lead_id for q in quotations if q.lead_id}
    tender_ids = {getattr(q, "tender_id", None) for q in quotations if getattr(q, "tender_id", None)}

    lead_map: dict = {}
    if lead_ids:
        for l in db.query(Lead).filter(Lead.id.in_(lead_ids)).all():
            lead_map[l.id] = l

    tender_map: dict = {}
    if tender_ids:
        for t in db.query(Tender).filter(Tender.id.in_(tender_ids)).all():
            tender_map[t.id] = t
    letter_ids = {getattr(q, "letter_id", None) for q in quotations if getattr(q, "letter_id", None)}
    letter_map: dict = {}
    if letter_ids:
        for letter in db.query(Letter).filter(Letter.id.in_(letter_ids)).all():
            letter_map[letter.id] = letter
    quotation_ids = [int(q.id) for q in quotations if q.id]
    line_items_by_quotation = _line_items_by_quotation(db, quotation_ids)
    user_map = _quotation_user_map(db, quotations)
    rejection_reason_map = _quotation_rejection_reason_map(db, quotations)

    result = []
    for q in quotations:
        items = line_items_by_quotation.get(int(q.id), [])
        row = _serialize(
            q,
            items,
            db,
            user_map=user_map,
            rejection_reason_map=rejection_reason_map,
        )

        if getattr(q, "letter_id", None) and q.letter_id in letter_map:
            letter = letter_map[q.letter_id]
            row["letter_no"] = letter.letter_no or ""
            row["letter_title"] = letter.title or ""
            row["lead_title"] = letter.title or ""
            row["lead_ref_id"] = letter.letter_no or ""
            row["customer_name"] = letter.linked_record_label or letter.recipient_name or ""
            row["contact_person"] = letter.recipient_name or ""
            row["customer_address"] = letter.recipient_address or ""
        elif getattr(q, "tender_id", None) and q.tender_id in tender_map:
            t = tender_map[q.tender_id]
            row["tender_num"] = t.tender_num or ""
            row["tender_title"] = t.tender_title or ""
            row["customer_name"] = t.customer_name or ""
            row["lead_title"] = t.tender_title or ""
            row["lead_ref_id"] = t.tender_num or ""
        elif q.lead_id and q.lead_id in lead_map:
            l = lead_map[q.lead_id]
            row["lead_title"] = l.lead_title or ""
            row["lead_ref_id"] = l.lead_ref_id or ""
            row["customer_name"] = l.customer_name or ""
            row["contact_person"] = l.contact_person or ""
            row["customer_address"] = l.customer_address or ""

        result.append(row)

    return result


# ─── GET /quotations/by-lead/{lead_id} ───────────────────────────────────────

@router.get("/by-lead/{lead_id}")
def list_by_lead(
    lead_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("quotations.view")),
):
    _ensure_quotation_runtime_schema(db)

    quotations = (
        _scope_quotations(db, db.query(Quotation), cu)
        .filter(Quotation.lead_id == lead_id)
        .order_by(Quotation.revision_number.desc(), Quotation.id.desc())
        .all()
    )
    quotation_ids = [int(q.id) for q in quotations if q.id]
    line_items_by_quotation = _line_items_by_quotation(db, quotation_ids)
    user_map = _quotation_user_map(db, quotations)
    rejection_reason_map = _quotation_rejection_reason_map(db, quotations)
    result = []
    for q in quotations:
        result.append(
            _serialize(
                q,
                line_items_by_quotation.get(int(q.id), []),
                db,
                user_map=user_map,
                rejection_reason_map=rejection_reason_map,
            )
        )
    return result


# ─── GET /quotations/{id} ─────────────────────────────────────────────────────

@router.get("/{quotation_id}")
def get_quotation(
    quotation_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("quotations.view")),
):
    _ensure_quotation_runtime_schema(db)

    q = _get_or_404(db, quotation_id, cu)
    items = (
        db.query(QuotationLineItem)
        .filter(QuotationLineItem.quotation_id == q.id)
        .order_by(QuotationLineItem.sort_order)
        .all()
    )
    return _serialize(q, items, db)
