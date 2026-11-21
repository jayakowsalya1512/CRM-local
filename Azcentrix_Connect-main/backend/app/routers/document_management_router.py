from __future__ import annotations

import logging
import math
import os
from datetime import date, datetime, time
from typing import Any
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy import and_, false, or_
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.logging import log_module_action
from app.core.validators import NonBlank, field_error
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, require_permission
from app.models.all_models import (
    ApprovalRequest,
    Customer,
    EMDBG,
    EMDBGRenewalHistory,
    DocumentFolder,
    DocumentManagementFile,
    DocumentShare,
    DocumentStar,
    DocumentTrash,
    Lead,
    Letter,
    Module,
    Permission,
    Quotation,
    RFPAnalysis,
    Role,
    RolePermission,
    TADAClaim,
    TADAAttachment,
    Tender,
    TenderDocument,
    User,
    WOMilestone,
    WOInvoice,
    WorkOrder,
)
from app.utils.data_scope import apply_data_scope, get_module_data_scope, get_team_user_ids
from app.utils.file_storage import (
    delete_stored_file,
    media_slug_from_request,
    media_url_to_logical_path,
    save_upload_optimized,
    stored_file_accounted_size,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Document Management"])

MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "media")
ALLOWED_UPLOAD_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".csv", ".zip", ".txt", ".sql",
}
DOCUMENT_SOURCE_LABELS = {
    "customers": "Customers",
    "leads": "Leads",
    "tenders": "Tenders",
    "quotations": "Quotations",
    "workorders": "Orders & Projects",
    "emdbg": "EMD / BG",
    "rfp": "RFP Analysis",
    "travel": "Travel / TA-DA",
    "letters": "Letter Management",
    "products": "Product & Price Books",
    "standalone": "Uploads",
}
LINKABLE_SOURCES = {key for key in DOCUMENT_SOURCE_LABELS if key != "standalone"}
DOCUMENT_APPROVAL_STATUSES = {"uploaded", "pending_approval", "approved", "rejected"}
DOCUMENT_APPROVAL_STATUS_LABELS = {
    "uploaded": "Uploaded",
    "pending_approval": "Pending Approval",
    "approved": "Approved",
    "rejected": "Rejected",
}


def _document_approval_status_label(approval_status: str | None) -> str:
    return DOCUMENT_APPROVAL_STATUS_LABELS.get(approval_status or "uploaded", "Uploaded")


TENDER_DOCUMENT_APPROVAL_ACTIONS = {
    "boq": "workings",
    "corrigendum": "workings",
    "oem document": "workings",
    "po document": "po_details",
    "tender document": "tender_details",
    "workings": "workings",
}


def _clean_document_key(value: str | None) -> str:
    return str(value or "").replace("_", " ").replace("-", " ").strip().lower()


def _approval_stage_label(value: str | None, *, draft_label: str = "Uploaded") -> str:
    clean = _clean_document_key(value)
    if not clean or clean in {"draft", "none", "new"}:
        return draft_label
    if "reject" in clean:
        return "Rejected"
    if "approve" in clean or clean in {"active", "step3 active"}:
        return "Approved"
    if "pending" in clean or "review" in clean or "waiting" in clean:
        return "Pending"
    if "upload" in clean or "submit" in clean:
        return "Uploaded"
    return draft_label


def _latest_tender_approval_status(db: Session, tender_id: int | None, action_key: str) -> str | None:
    if not tender_id:
        return None
    try:
        request_row = (
            db.query(ApprovalRequest)
            .filter(
                ApprovalRequest.module_key == "tender",
                ApprovalRequest.action_key == action_key,
                ApprovalRequest.record_id == tender_id,
            )
            .order_by(
                ApprovalRequest.requested_at.desc(),
                ApprovalRequest.id.desc(),
            )
            .first()
        )
    except SQLAlchemyError:
        db.rollback()
        return None
    return getattr(request_row, "status", None) if request_row else None


def _tender_document_stage(db: Session, tender: Tender | None, doc_type: str | None) -> str:
    if tender is None:
        return "Uploaded"

    doc_key = _clean_document_key(doc_type)
    action_key = TENDER_DOCUMENT_APPROVAL_ACTIONS.get(doc_key, "tender_details")
    latest_status = _latest_tender_approval_status(db, getattr(tender, "id", None), action_key)
    if latest_status:
        return _approval_stage_label(latest_status)

    workflow_status = _clean_document_key(getattr(tender, "workflow_status", None))

    if action_key == "po_details":
        return _approval_stage_label(getattr(tender, "po_workflow_status", None))

    if action_key == "workings":
        if getattr(tender, "step3_approved_at", None):
            return "Approved"
        if workflow_status == "step3 pending":
            return "Pending"
        if workflow_status == "step3 active":
            return "Approved"
        return "Uploaded"

    if getattr(tender, "step2_approved_at", None):
        return "Approved"
    if workflow_status == "rejected":
        return "Rejected"
    if workflow_status == "step2 pending":
        return "Pending"
    if workflow_status in {"active", "step3 pending", "step3 active"}:
        return "Approved"
    return "Uploaded"


SOURCE_VIEW_PERMISSION_KEYS = {
    "customers": "customers.view",
    "leads": "leads.view",
    "tenders": "tenders.view",
    "quotations": "quotations.view",
    "workorders": "workorders.view",
    "emdbg": "emdbg.view",
    "rfp": "rfp.view",
    "travel": "travel.view",
    "letters": "letter_management.view",
    "products": "products.view",
}


def _document_id(
    source_key: str,
    record_id: int | None,
    row_id: int | None,
    doc_type: str,
) -> str:
    return f"{source_key}:{record_id or 0}:{row_id or 0}:{doc_type}".replace(" ", "_").lower()


def _user_has_permission_key(db: Session, current_user: User, permission_key: str) -> bool:
    role_row = db.query(Role).filter(
        Role.name == current_user.role,
        Role.is_active == True,
    ).first()
    if not role_row:
        return False

    permission = db.query(Permission).filter(Permission.key == permission_key).first()
    if not permission:
        return False

    module_key = (permission.module or "").strip().lower()
    if module_key:
        from app.services.tenant_module_service import DEFAULT_TENANT_MODULE_KEYS

        module = db.query(Module).filter(Module.key == module_key).first()
        if (module_key in DEFAULT_TENANT_MODULE_KEYS and not module) or (module and not bool(module.is_active)):
            return False

    return db.query(RolePermission).filter(
        RolePermission.role_id == role_row.id,
        RolePermission.permission_id == permission.id,
    ).first() is not None


def _user_can_view_source(db: Session, current_user: User, source_key: str | None) -> bool:
    clean_source = str(source_key or "").strip().lower()
    if not clean_source or clean_source == "standalone":
        return True
    permission_key = SOURCE_VIEW_PERMISSION_KEYS.get(clean_source)
    return bool(permission_key and _user_has_permission_key(db, current_user, permission_key))


def _ensure_source_view_permission(db: Session, current_user: User, source_key: str) -> None:
    if not _user_can_view_source(db, current_user, source_key):
        label = DOCUMENT_SOURCE_LABELS.get(source_key, source_key.title())
        raise HTTPException(403, f"You don't have permission to view {label} records")


def _document_scope_user_ids(db: Session, current_user: User) -> list[int] | None:
    scope = get_module_data_scope(db, current_user, "document_management")
    if scope == "all":
        return None
    if scope == "none":
        return []
    if scope == "team":
        return get_team_user_ids(db, int(current_user.id))
    return [int(current_user.id)]


def _shared_standalone_file_ids(db: Session, current_user: User) -> set[int]:
    try:
        rows = (
            db.query(DocumentShare.document_id)
            .filter(DocumentShare.shared_with == current_user.id)
            .all()
        )
    except SQLAlchemyError:
        db.rollback()
        return set()

    file_ids: set[int] = set()
    for (document_id,) in rows:
        try:
            row_id = _standalone_document_row_id(str(document_id or ""))
        except HTTPException:
            continue
        if row_id is not None:
            file_ids.add(row_id)
    return file_ids


def _apply_standalone_document_scope(db: Session, query, current_user: User):
    user_ids = _document_scope_user_ids(db, current_user)
    if user_ids is None:
        return query
    if not user_ids:
        return query.filter(false())

    conditions = [DocumentManagementFile.uploaded_by.in_(user_ids)]
    shared_file_ids = _shared_standalone_file_ids(db, current_user)
    if shared_file_ids:
        conditions.append(DocumentManagementFile.id.in_(shared_file_ids))
    return query.filter(or_(*conditions))


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return None


def _sort_value(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, time.min)
    return datetime.min


def _name_from_url(url: str | None, fallback: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return fallback
    path = urlparse(raw).path or raw.split("?", 1)[0]
    name = unquote(path.rstrip("/").rsplit("/", 1)[-1])
    return name or fallback


def _file_extension(name: str | None, url: str | None) -> str:
    for value in (name, url):
        raw = str(value or "").strip()
        if not raw:
            continue
        path = urlparse(raw).path or raw.split("?", 1)[0]
        ext = os.path.splitext(unquote(path.rstrip("/")))[-1].strip(".").lower()
        if ext:
            return "jpg" if ext == "jpeg" else ext
    return "file"


def _stored_size_kb_from_url(url: str | None) -> int | None:
    try:
        logical_path = media_url_to_logical_path(root_dir=os.path.abspath(MEDIA_ROOT), file_url=str(url or ""))
        stored_bytes = stored_file_accounted_size(logical_path)
    except Exception:
        return None
    if stored_bytes <= 0:
        return None
    return max(1, math.ceil(stored_bytes / 1024))


def _user_names(db: Session, user_ids: set[int]) -> dict[int, str]:
    if not user_ids:
        return {}
    try:
        rows = (
            db.query(User.id, User.full_name, User.username)
            .filter(User.id.in_(sorted(user_ids)))
            .all()
        )
        return {
            int(user_id): (full_name or username or f"User {user_id}")
            for user_id, full_name, username in rows
        }
    except SQLAlchemyError:
        db.rollback()
        return {}


def _combine_subtitle(*parts: str | None) -> str:
    return " · ".join(str(p).strip() for p in parts if str(p or "").strip())


def _record_option(source_key: str, record_id: int, label: str | None, subtitle: str | None = None) -> dict[str, Any]:
    source = DOCUMENT_SOURCE_LABELS.get(source_key, source_key.title())
    return {
        "id": int(record_id),
        "source_key": source_key,
        "source": source,
        "label": label or f"{source} #{record_id}",
        "subtitle": subtitle or "",
    }


def _search_conditions(term: str, model_id, *columns):
    conditions = [column.ilike(f"%{term}%") for column in columns]
    if term.isdigit():
        conditions.append(model_id == int(term))
    return conditions


def _link_record_options(
    db: Session,
    current_user: User,
    source_key: str,
    *,
    search: str = "",
    limit: int = 25,
    record_id: int | None = None,
) -> list[dict[str, Any]]:
    _ensure_source_view_permission(db, current_user, source_key)
    term = search.strip()

    if source_key == "customers":
        query = db.query(Customer).filter(Customer.is_deleted == False)
        query = apply_data_scope(db, query, current_user, "customers", Customer.created_by, Customer.assigned_to)
        if record_id is not None:
            query = query.filter(Customer.id == record_id)
        elif term:
            query = query.filter(or_(*_search_conditions(
                term,
                Customer.id,
                Customer.customer_name,
                Customer.billing_city,
                Customer.billing_state,
            )))
        rows = query.order_by(Customer.updated_at.desc(), Customer.created_at.desc(), Customer.id.desc()).limit(limit).all()
        return [
            _record_option("customers", row.id, row.customer_name, row.billing_city or row.billing_state or row.account_status)
            for row in rows
        ]

    if source_key == "leads":
        query = db.query(Lead).filter(Lead.is_deleted == False)
        query = apply_data_scope(db, query, current_user, "leads", Lead.created_by, Lead.assigned_to)
        if record_id is not None:
            query = query.filter(Lead.id == record_id)
        elif term:
            query = query.filter(or_(*_search_conditions(
                term,
                Lead.id,
                Lead.lead_title,
                Lead.lead_ref_id,
                Lead.opportunity_ref_id,
                Lead.customer_name,
            )))
        rows = query.order_by(Lead.updated_at.desc(), Lead.created_at.desc(), Lead.id.desc()).limit(limit).all()
        return [
            _record_option(
                "leads",
                row.id,
                row.lead_title,
                _combine_subtitle(row.lead_ref_id, row.customer_name) or row.status,
            )
            for row in rows
        ]

    if source_key == "tenders":
        query = db.query(Tender).filter(Tender.is_deleted == False)
        query = apply_data_scope(db, query, current_user, "tenders", Tender.created_by, Tender.assigned_to)
        if record_id is not None:
            query = query.filter(Tender.id == record_id)
        elif term:
            query = query.filter(or_(*_search_conditions(
                term,
                Tender.id,
                Tender.tender_title,
                Tender.tender_num,
                Tender.portal_ref_number,
                Tender.customer_name,
            )))
        rows = query.order_by(Tender.updated_at.desc(), Tender.created_at.desc(), Tender.id.desc()).limit(limit).all()
        return [
            _record_option(
                "tenders",
                row.id,
                row.tender_title or row.portal_ref_number or row.tender_num,
                _combine_subtitle(row.tender_num, row.customer_name) or row.tender_status,
            )
            for row in rows
        ]

    if source_key == "quotations":
        query = db.query(Quotation)
        query = apply_data_scope(db, query, current_user, "quotations", Quotation.created_by)
        if record_id is not None:
            query = query.filter(Quotation.id == record_id)
        elif term:
            query = query.filter(or_(*_search_conditions(
                term,
                Quotation.id,
                Quotation.quotation_number,
                Quotation.subject,
                Quotation.customer_to_name,
            )))
        rows = query.order_by(Quotation.updated_at.desc(), Quotation.created_at.desc(), Quotation.id.desc()).limit(limit).all()
        return [
            _record_option(
                "quotations",
                row.id,
                row.subject or row.quotation_number,
                _combine_subtitle(row.quotation_number, row.customer_to_name) or row.status,
            )
            for row in rows
        ]

    if source_key == "workorders":
        query = db.query(WorkOrder)
        query = apply_data_scope(db, query, current_user, "workorders", WorkOrder.created_by, WorkOrder.project_manager_id)
        if record_id is not None:
            query = query.filter(WorkOrder.id == record_id)
        elif term:
            query = query.filter(or_(*_search_conditions(
                term,
                WorkOrder.id,
                WorkOrder.wo_number,
                WorkOrder.project_title,
                WorkOrder.customer_name,
                WorkOrder.po_number,
            )))
        rows = query.order_by(WorkOrder.updated_at.desc(), WorkOrder.created_at.desc(), WorkOrder.id.desc()).limit(limit).all()
        return [
            _record_option(
                "workorders",
                row.id,
                row.project_title or row.wo_number,
                _combine_subtitle(row.wo_number, row.customer_name) or row.status,
            )
            for row in rows
        ]

    if source_key == "emdbg":
        query = db.query(EMDBG)
        query = apply_data_scope(db, query, current_user, "emdbg", EMDBG.created_by)
        if record_id is not None:
            query = query.filter(EMDBG.id == record_id)
        elif term:
            query = query.filter(or_(*_search_conditions(
                term,
                EMDBG.id,
                EMDBG.reference_num,
                EMDBG.tender_num,
                EMDBG.client_name,
                EMDBG.instrument_number,
            )))
        rows = query.order_by(EMDBG.updated_at.desc(), EMDBG.created_at.desc(), EMDBG.id.desc()).limit(limit).all()
        return [
            _record_option(
                "emdbg",
                row.id,
                row.reference_num,
                _combine_subtitle(row.tender_num, row.client_name) or row.status,
            )
            for row in rows
        ]

    if source_key == "rfp":
        query = db.query(RFPAnalysis, Tender).outerjoin(Tender, Tender.id == RFPAnalysis.tender_id)
        query = apply_data_scope(db, query, current_user, "tenders", Tender.created_by, Tender.assigned_to)
        if record_id is not None:
            query = query.filter(RFPAnalysis.id == record_id)
        elif term:
            query = query.filter(or_(
                *_search_conditions(term, RFPAnalysis.id, RFPAnalysis.document_name),
                Tender.tender_title.ilike(f"%{term}%"),
                Tender.tender_num.ilike(f"%{term}%"),
                Tender.portal_ref_number.ilike(f"%{term}%"),
            ))
        rows = query.order_by(RFPAnalysis.created_at.desc(), RFPAnalysis.id.desc()).limit(limit).all()
        return [
            _record_option(
                "rfp",
                analysis.id,
                analysis.document_name or getattr(tender, "tender_title", None),
                _combine_subtitle(
                    getattr(tender, "tender_num", None) or getattr(tender, "portal_ref_number", None),
                    getattr(tender, "customer_name", None),
                ) or analysis.status,
            )
            for analysis, tender in rows
        ]

    if source_key == "travel":
        query = db.query(TADAClaim)
        query = apply_data_scope(db, query, current_user, "travel", TADAClaim.employee_id)
        if record_id is not None:
            query = query.filter(TADAClaim.id == record_id)
        elif term:
            query = query.filter(or_(*_search_conditions(
                term,
                TADAClaim.id,
                TADAClaim.claim_number,
                TADAClaim.from_city,
                TADAClaim.to_city,
                TADAClaim.purpose,
            )))
        rows = query.order_by(TADAClaim.updated_at.desc(), TADAClaim.created_at.desc(), TADAClaim.id.desc()).limit(limit).all()
        return [
            _record_option("travel", row.id, row.claim_number, row.purpose or row.overall_status)
            for row in rows
        ]

    if source_key == "letters":
        query = db.query(Letter).filter(Letter.is_deleted == False)
        if record_id is not None:
            query = query.filter(Letter.id == record_id)
        elif term:
            query = query.filter(or_(*_search_conditions(
                term,
                Letter.id,
                Letter.letter_no,
                Letter.title,
                Letter.recipient_name,
                Letter.linked_record_label,
            )))
        rows = query.order_by(Letter.updated_at.desc(), Letter.created_at.desc(), Letter.id.desc()).limit(limit).all()
        return [
            _record_option(
                "letters",
                row.id,
                row.title or row.letter_no,
                _combine_subtitle(row.letter_no, row.linked_record_label or row.recipient_name) or row.status,
            )
            for row in rows
        ]

    if source_key == "products":
        # Product & Price Books catalogue (products_master; SKU column added by product_service)
        from sqlalchemy import text as _t
        sql = "SELECT id, name, sku, category FROM products_master WHERE (is_active = 1 OR is_active IS NULL)"
        params: dict[str, Any] = {"lim": limit}
        if record_id is not None:
            sql += " AND id = :rid"
            params["rid"] = record_id
        elif term:
            sql += " AND (name LIKE :t OR sku LIKE :t OR category LIKE :t)"
            params["t"] = f"%{term}%"
        rows = db.execute(_t(sql + " ORDER BY name LIMIT :lim"), params).mappings().all()
        return [_record_option("products", r["id"], r["name"], _combine_subtitle(r["sku"], r["category"])) for r in rows]

    raise HTTPException(400, "Unsupported link source")


def _resolve_linked_record(
    db: Session,
    current_user: User,
    source_key: str | None,
    record_id: int | None,
) -> dict[str, Any] | None:
    clean_source = str(source_key or "").strip().lower()
    if not clean_source or clean_source == "standalone":
        return None
    if clean_source not in LINKABLE_SOURCES:
        raise HTTPException(400, "Unsupported link source")
    if not record_id:
        raise HTTPException(400, "Please select a record to link this document")

    matches = _link_record_options(
        db,
        current_user,
        clean_source,
        limit=1,
        record_id=int(record_id),
    )
    if not matches:
        raise HTTPException(404, "Linked record not found or not accessible")
    return matches[0]


def _add_document(
    documents: list[dict[str, Any]],
    *,
    source_key: str,
    source: str,
    record_id: int | None,
    row_id: int | None,
    name: str,
    url: str | None,
    doc_type: str,
    record_label: str,
    owner_id: int | None = None,
    updated_at: Any = None,
    created_at: Any = None,
    status: str | None = None,
    size_kb: int | None = None,
    folder_id: int | None = None,
    deleted_at: Any = None,
    is_deleted: bool = False,
    can_trash: bool = True,
    id_source_key: str | None = None,
    approval_status: str | None = None,
    approval_submitted_by: int | None = None,
    approval_submitted_at: Any = None,
    approval_decided_by: int | None = None,
    approval_decided_at: Any = None,
    approval_comment: str | None = None,
    can_submit_approval: bool = False,
) -> None:
    clean_url = str(url or "").strip()
    if not clean_url:
        return
    document_id_source = str(id_source_key or source_key).strip().lower()
    display_name = name or _name_from_url(clean_url, doc_type)
    resolved_size_kb = size_kb if size_kb is not None else _stored_size_kb_from_url(clean_url)

    documents.append({
        "id": _document_id(document_id_source, record_id, row_id, doc_type),
        "name": display_name,
        "source_key": source_key,
        "source": source,
        "record_id": record_id,
        "record_label": record_label or "-",
        "doc_type": doc_type,
        "file_type": _file_extension(display_name, clean_url).upper(),
        "file_extension": _file_extension(display_name, clean_url),
        "owner_id": owner_id,
        "owner": None,
        "updated_at": _iso(updated_at),
        "created_at": _iso(created_at) if created_at is not None else _iso(updated_at),
        "status": status or doc_type,
        "url": clean_url,
        "size_kb": resolved_size_kb,
        "folder_id": folder_id,
        "deleted_at": _iso(deleted_at),
        "is_deleted": bool(is_deleted),
        "can_trash": bool(can_trash),
        "approval_status": approval_status,
        "approval_submitted_by_id": approval_submitted_by,
        "approval_submitted_at": _iso(approval_submitted_at),
        "approval_decided_by_id": approval_decided_by,
        "approval_decided_at": _iso(approval_decided_at),
        "approval_comment": approval_comment,
        "can_submit_approval": bool(can_submit_approval),
        "_sort_at": _sort_value(updated_at),
    })


def _collect_tender_documents(
    db: Session,
    current_user: User,
    documents: list[dict[str, Any]],
    limit: int,
    *,
    customer_id: int | None = None,
) -> None:
    query = (
        db.query(TenderDocument, Tender)
        .outerjoin(Tender, Tender.id == TenderDocument.tender_id)
        .filter(TenderDocument.file_url.isnot(None), TenderDocument.file_url != "")
    )
    query = apply_data_scope(db, query, current_user, "tenders", Tender.created_by, Tender.assigned_to)
    if customer_id is not None:
        query = query.filter(Tender.customer_id == customer_id)
    rows = query.order_by(TenderDocument.created_at.desc(), TenderDocument.id.desc()).limit(limit).all()

    for doc, tender in rows:
        label = (
            getattr(tender, "tender_title", None)
            or getattr(tender, "portal_ref_number", None)
            or f"Tender #{doc.tender_id}"
        )
        _add_document(
            documents,
            source_key="tenders",
            source="Tenders",
            record_id=doc.tender_id,
            row_id=doc.id,
            name=doc.file_name or _name_from_url(doc.file_url, str(doc.doc_type or "Tender Document")),
            url=doc.file_url,
            doc_type=str(doc.doc_type or "Tender Document"),
            record_label=label,
            owner_id=doc.uploaded_by,
            updated_at=doc.created_at,
            status=_tender_document_stage(db, tender, str(doc.doc_type or "Tender Document")),
            size_kb=getattr(doc, "file_size_kb", None),
        )


def _collect_work_order_documents(
    db: Session,
    current_user: User,
    documents: list[dict[str, Any]],
    limit: int,
    *,
    customer_id: int | None = None,
) -> None:
    query = db.query(WorkOrder).filter(
        (WorkOrder.po_doc.isnot(None) & (WorkOrder.po_doc != ""))
        | (WorkOrder.po_document_url.isnot(None) & (WorkOrder.po_document_url != ""))
        | (WorkOrder.completion_certificate_url.isnot(None) & (WorkOrder.completion_certificate_url != ""))
    )
    query = apply_data_scope(db, query, current_user, "workorders", WorkOrder.created_by, WorkOrder.project_manager_id)
    if customer_id is not None:
        query = query.filter(WorkOrder.customer_id == customer_id)
    rows = query.order_by(WorkOrder.updated_at.desc(), WorkOrder.created_at.desc(), WorkOrder.id.desc()).limit(limit).all()

    seen_urls: set[str] = set()
    for wo in rows:
        label = wo.project_title or wo.wo_number or f"Work Order #{wo.id}"
        for field, doc_type in (
            ("po_doc", "PO Document"),
            ("po_document_url", "PO Document"),
            ("completion_certificate_url", "Completion Certificate"),
        ):
            url = str(getattr(wo, field, "") or "").strip()
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            _add_document(
                documents,
                source_key="workorders",
                source="Orders & Projects",
                record_id=wo.id,
                row_id=wo.id,
                name=_name_from_url(url, f"{doc_type} - {wo.wo_number or wo.id}"),
                url=url,
                doc_type=doc_type,
                record_label=label,
                owner_id=wo.created_by,
                updated_at=wo.updated_at or wo.created_at,
                created_at=wo.created_at,
                status=str(wo.status or doc_type),
            )


def _collect_work_order_child_documents(
    db: Session,
    current_user: User,
    documents: list[dict[str, Any]],
    limit: int,
    *,
    customer_id: int | None = None,
) -> None:
    milestone_query = (
        db.query(WOMilestone, WorkOrder)
        .join(WorkOrder, WorkOrder.id == WOMilestone.wo_id)
        .filter(WOMilestone.document_url.isnot(None), WOMilestone.document_url != "")
    )
    milestone_query = apply_data_scope(
        db,
        milestone_query,
        current_user,
        "workorders",
        WorkOrder.created_by,
        WorkOrder.project_manager_id,
    )
    if customer_id is not None:
        milestone_query = milestone_query.filter(WorkOrder.customer_id == customer_id)
    for milestone, wo in milestone_query.order_by(WOMilestone.due_date.desc(), WOMilestone.id.desc()).limit(limit).all():
        url = str(milestone.document_url or "").strip()
        _add_document(
            documents,
            source_key="workorders",
            source="Orders & Projects",
            record_id=wo.id,
            row_id=milestone.id,
            name=_name_from_url(url, milestone.title or "Milestone Document"),
            url=url,
            doc_type="Milestone Document",
            record_label=wo.project_title or wo.wo_number or f"Work Order #{wo.id}",
            owner_id=wo.created_by,
            updated_at=milestone.completed_date or milestone.due_date,
            status=str(milestone.status or "Milestone"),
        )

    invoice_query = (
        db.query(WOInvoice, WorkOrder)
        .join(WorkOrder, WorkOrder.id == WOInvoice.wo_id)
        .filter(WOInvoice.document_url.isnot(None), WOInvoice.document_url != "")
    )
    invoice_query = apply_data_scope(
        db,
        invoice_query,
        current_user,
        "workorders",
        WorkOrder.created_by,
        WorkOrder.project_manager_id,
    )
    if customer_id is not None:
        invoice_query = invoice_query.filter(WorkOrder.customer_id == customer_id)
    for invoice, wo in invoice_query.order_by(WOInvoice.invoice_date.desc(), WOInvoice.id.desc()).limit(limit).all():
        url = str(invoice.document_url or "").strip()
        _add_document(
            documents,
            source_key="workorders",
            source="Orders & Projects",
            record_id=wo.id,
            row_id=invoice.id,
            name=_name_from_url(url, invoice.invoice_number or "Invoice Document"),
            url=url,
            doc_type="Invoice Document",
            record_label=wo.project_title or wo.wo_number or f"Work Order #{wo.id}",
            owner_id=wo.created_by,
            updated_at=invoice.invoice_date,
            status=str(invoice.payment_status or "Invoice"),
        )


def _collect_emdbg_documents(
    db: Session,
    current_user: User,
    documents: list[dict[str, Any]],
    limit: int,
    *,
    customer_id: int | None = None,
) -> None:
    query = db.query(EMDBG).filter(
        (EMDBG.instrument_document_url.isnot(None) & (EMDBG.instrument_document_url != ""))
        | (EMDBG.release_document_url.isnot(None) & (EMDBG.release_document_url != ""))
        | (EMDBG.payment_proof_url.isnot(None) & (EMDBG.payment_proof_url != ""))
        | (EMDBG.return_document_url.isnot(None) & (EMDBG.return_document_url != ""))
    )
    query = apply_data_scope(db, query, current_user, "emdbg", EMDBG.created_by)
    if customer_id is not None:
        query = query.filter(EMDBG.customer_id == customer_id)
    rows = query.order_by(EMDBG.updated_at.desc(), EMDBG.created_at.desc(), EMDBG.id.desc()).limit(limit).all()

    for item in rows:
        label = item.reference_num or item.tender_num or f"EMD/BG #{item.id}"
        for field, size_field, owner_field, date_field, doc_type in (
            ("instrument_document_url", "instrument_file_size_kb", "created_by", "created_at", "Instrument Document"),
            ("payment_proof_url", "payment_proof_size_kb", "finance_paid_by", "updated_at", "Payment Proof"),
            ("return_document_url", "return_file_size_kb", "return_uploaded_by", "return_uploaded_at", "Return Document"),
            ("release_document_url", "release_file_size_kb", "created_by", "release_date", "Release Document"),
        ):
            url = str(getattr(item, field, "") or "").strip()
            if not url:
                continue
            _add_document(
                documents,
                source_key="emdbg",
                source="EMD / BG",
                record_id=item.id,
                row_id=item.id,
                name=_name_from_url(url, f"{doc_type} - {label}"),
                url=url,
                doc_type=doc_type,
                record_label=label,
                owner_id=getattr(item, owner_field, None),
                updated_at=getattr(item, date_field, None) or item.updated_at or item.created_at,
                created_at=item.created_at,
                status=str(item.status or doc_type),
                size_kb=getattr(item, size_field, None),
            )

    renewal_query = (
        db.query(EMDBGRenewalHistory, EMDBG)
        .join(EMDBG, EMDBG.id == EMDBGRenewalHistory.emdbg_id)
        .filter(EMDBGRenewalHistory.renewal_document_url.isnot(None), EMDBGRenewalHistory.renewal_document_url != "")
    )
    renewal_query = apply_data_scope(db, renewal_query, current_user, "emdbg", EMDBG.created_by)
    if customer_id is not None:
        renewal_query = renewal_query.filter(EMDBG.customer_id == customer_id)
    for renewal, item in renewal_query.order_by(EMDBGRenewalHistory.created_at.desc(), EMDBGRenewalHistory.id.desc()).limit(limit).all():
        url = str(renewal.renewal_document_url or "").strip()
        label = item.reference_num or item.tender_num or f"EMD/BG #{item.id}"
        _add_document(
            documents,
            source_key="emdbg",
            source="EMD / BG",
            record_id=item.id,
            row_id=renewal.id,
            name=_name_from_url(url, f"Renewal Document - {label}"),
            url=url,
            doc_type="Renewal Document",
            record_label=label,
            owner_id=renewal.renewed_by,
            updated_at=renewal.created_at,
            status="Renewal",
            size_kb=renewal.renewal_file_size_kb,
        )


def _collect_rfp_documents(
    db: Session,
    current_user: User,
    documents: list[dict[str, Any]],
    limit: int,
    *,
    customer_id: int | None = None,
) -> None:
    query = (
        db.query(RFPAnalysis, Tender)
        .outerjoin(Tender, Tender.id == RFPAnalysis.tender_id)
        .filter(RFPAnalysis.document_url.isnot(None), RFPAnalysis.document_url != "")
    )
    query = apply_data_scope(db, query, current_user, "tenders", Tender.created_by, Tender.assigned_to)
    if customer_id is not None:
        query = query.filter(Tender.customer_id == customer_id)
    rows = query.order_by(RFPAnalysis.created_at.desc(), RFPAnalysis.id.desc()).limit(limit).all()

    for analysis, tender in rows:
        label = (
            getattr(tender, "tender_title", None)
            or getattr(tender, "portal_ref_number", None)
            or f"RFP Analysis #{analysis.id}"
        )
        _add_document(
            documents,
            source_key="rfp",
            source="RFP Analysis",
            record_id=analysis.id,
            row_id=analysis.id,
            name=analysis.document_name or _name_from_url(analysis.document_url, "RFP Document"),
            url=analysis.document_url,
            doc_type="RFP Document",
            record_label=label,
            owner_id=analysis.created_by,
            updated_at=analysis.created_at,
            status=str(analysis.status or "Uploaded"),
        )


def _collect_tada_documents(
    db: Session,
    current_user: User,
    documents: list[dict[str, Any]],
    limit: int,
    *,
    customer_id: int | None = None,
) -> None:
    if customer_id is not None:
        return  # travel claims are not linked to a customer
    query = (
        db.query(TADAAttachment, TADAClaim)
        .join(TADAClaim, TADAClaim.id == TADAAttachment.claim_id)
        .filter(TADAAttachment.file_url.isnot(None), TADAAttachment.file_url != "")
    )
    query = apply_data_scope(db, query, current_user, "travel", TADAClaim.employee_id)
    rows = query.order_by(TADAAttachment.created_at.desc(), TADAAttachment.id.desc()).limit(limit).all()

    for attachment, claim in rows:
        _add_document(
            documents,
            source_key="travel",
            source="Travel / TA-DA",
            record_id=claim.id,
            row_id=attachment.id,
            name=attachment.file_name or _name_from_url(attachment.file_url, str(attachment.doc_type or "Receipt")),
            url=attachment.file_url,
            doc_type=str(attachment.doc_type or "Receipt"),
            record_label=claim.claim_number or f"TA/DA Claim #{claim.id}",
            owner_id=attachment.uploaded_by or claim.employee_id,
            updated_at=attachment.created_at,
            status=str(claim.overall_status or attachment.doc_type or "Uploaded"),
            size_kb=attachment.file_size_kb,
        )


def _customer_record_ids(db: Session, customer_id: int) -> dict[str, set[int]]:
    scope: dict[str, tuple[Any, Any]] = {
        "leads": (Lead, Lead.customer_id),
        "tenders": (Tender, Tender.customer_id),
        "workorders": (WorkOrder, WorkOrder.customer_id),
        "emdbg": (EMDBG, EMDBG.customer_id),
        "quotations": (Quotation, Quotation.customer_id),
    }
    result: dict[str, set[int]] = {}
    for source_key, (model, column) in scope.items():
        try:
            result[source_key] = {row[0] for row in db.query(model.id).filter(column == customer_id).all()}
        except SQLAlchemyError:
            db.rollback()
            result[source_key] = set()
    # Letters point at their customer through linked_source/linked_record_id.
    try:
        result["letters"] = {row[0] for row in db.query(Letter.id).filter(
            Letter.linked_source.in_(("customer", "customers")), Letter.linked_record_id == customer_id,
        ).all()}
    except SQLAlchemyError:
        db.rollback()
        result["letters"] = set()
    return result


def _standalone_file_link_accessible(db: Session, current_user: User, item: DocumentManagementFile) -> bool:
    linked_source = str(item.linked_source or "standalone").strip().lower() or "standalone"
    if linked_source == "standalone":
        return True
    if linked_source not in LINKABLE_SOURCES:
        return False
    if not item.linked_record_id:
        return False
    try:
        return bool(_link_record_options(
            db,
            current_user,
            linked_source,
            limit=1,
            record_id=int(item.linked_record_id),
        ))
    except HTTPException:
        return False
    except SQLAlchemyError:
        db.rollback()
        return False


def _collect_standalone_documents(
    db: Session,
    current_user: User,
    documents: list[dict[str, Any]],
    limit: int,
    *,
    include_deleted: bool = False,
    source_filter: str = "",
    customer_id: int | None = None,
    customer_scope: dict[str, set[int]] | None = None,
    folder_id: int | None = None,
) -> None:
    query = db.query(DocumentManagementFile)
    query = _apply_standalone_document_scope(db, query, current_user)
    if include_deleted:
        query = query.filter(DocumentManagementFile.deleted_at.isnot(None))
        query = query.order_by(DocumentManagementFile.deleted_at.desc(), DocumentManagementFile.id.desc())
    else:
        query = query.filter(DocumentManagementFile.deleted_at.is_(None))
        query = query.order_by(DocumentManagementFile.created_at.desc(), DocumentManagementFile.id.desc())

    if folder_id is not None:
        query = query.filter(
            DocumentManagementFile.folder_id == folder_id,
            DocumentManagementFile.uploaded_by == current_user.id,
        )

    if customer_id is not None:
        conditions = [
            (DocumentManagementFile.linked_source == "customers")
            & (DocumentManagementFile.linked_record_id == customer_id)
        ]
        for src, ids in (customer_scope or {}).items():
            if ids:
                conditions.append(
                    (DocumentManagementFile.linked_source == src)
                    & (DocumentManagementFile.linked_record_id.in_(ids))
                )
        query = query.filter(or_(*conditions))

    if source_filter == "standalone":
        query = query.filter(
            (DocumentManagementFile.linked_source.is_(None))
            | (DocumentManagementFile.linked_source == "")
            | (DocumentManagementFile.linked_source == "standalone")
        )
    elif source_filter:
        query = query.filter(DocumentManagementFile.linked_source == source_filter)

    rows = query.limit(limit).all()
    for item in rows:
        if not _standalone_file_shared_with_user(db, current_user, item) and not _standalone_file_link_accessible(db, current_user, item):
            continue
        linked_source = str(item.linked_source or "standalone").strip().lower() or "standalone"
        linked_record_id = item.linked_record_id if linked_source != "standalone" else 0
        source_label = DOCUMENT_SOURCE_LABELS.get(linked_source, "Linked Record")
        record_label = (
            item.linked_record_label
            or (f"{source_label} #{linked_record_id}" if linked_record_id else None)
            or item.description
            or "Direct Upload"
        )
        doc_type = item.doc_type or "Uploaded Document"
        _add_document(
            documents,
            source_key=linked_source,
            source=source_label,
            record_id=linked_record_id,
            row_id=item.id,
            name=item.name or _name_from_url(item.file_url, "Document"),
            url=item.file_url,
            doc_type=doc_type,
            record_label=record_label,
            owner_id=item.uploaded_by,
            updated_at=item.deleted_at if include_deleted else item.created_at,
            created_at=item.created_at,
            status="In Trash" if include_deleted else _document_approval_status_label(item.approval_status),
            size_kb=item.file_size_kb,
            folder_id=item.folder_id,
            deleted_at=item.deleted_at,
            is_deleted=include_deleted,
            can_trash=True,
            id_source_key="standalone",
            approval_status=item.approval_status or "uploaded",
            approval_submitted_by=item.submitted_by,
            approval_submitted_at=item.submitted_at,
            approval_decided_by=item.approval_decided_by,
            approval_decided_at=item.approval_decided_at,
            approval_comment=item.approval_comment,
            can_submit_approval=(
                not include_deleted
                and item.uploaded_by == current_user.id
                and (item.approval_status or "uploaded") in ("uploaded", "rejected")
            ),
        )


COLLECTORS = (
    ("tenders", _collect_tender_documents),
    ("workorders", _collect_work_order_documents),
    ("workorders", _collect_work_order_child_documents),
    ("emdbg", _collect_emdbg_documents),
    ("rfp", _collect_rfp_documents),
    ("travel", _collect_tada_documents),
)


def _collect_documents(
    db: Session,
    current_user: User,
    *,
    source_filter: str,
    limit: int,
    trash: bool = False,
    customer_id: int | None = None,
    folder_id: int | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    documents: list[dict[str, Any]] = []
    skipped_sources: list[str] = []
    customer_scope = _customer_record_ids(db, customer_id) if customer_id is not None else {}

    # A folder view is a personal, standalone-only space — CRM-linked sources
    # (tenders, work orders, etc.) never live inside a My Folder folder.
    if folder_id is None:
        for source_key, collector in COLLECTORS:
            if source_filter and source_filter != source_key:
                continue
            if not _user_can_view_source(db, current_user, source_key):
                continue
            try:
                collector(db, current_user, documents, limit, customer_id=customer_id)
            except SQLAlchemyError as exc:
                db.rollback()
                skipped_sources.append(source_key)
                logger.warning("Document source '%s' skipped: %s", source_key, exc)

    try:
        _collect_standalone_documents(
            db,
            current_user,
            documents,
            limit,
            include_deleted=False,
            source_filter=source_filter,
            customer_id=customer_id,
            customer_scope=customer_scope,
            folder_id=folder_id,
        )
    except SQLAlchemyError as exc:
        db.rollback()
        skipped_sources.append("standalone")
        logger.warning("Document source 'standalone' skipped: %s", exc)

    if trash:
        try:
            _collect_standalone_documents(
                db,
                current_user,
                documents,
                limit,
                include_deleted=True,
                source_filter=source_filter,
                customer_id=customer_id,
                customer_scope=customer_scope,
                folder_id=folder_id,
            )
        except SQLAlchemyError as exc:
            db.rollback()
            skipped_sources.append("standalone")
            logger.warning("Document trash skipped: %s", exc)

    return documents, skipped_sources


def _filter_documents_by_search(documents: list[dict[str, Any]], search: str) -> list[dict[str, Any]]:
    if not search:
        return documents
    return [
        doc for doc in documents
        if search in " ".join(
            str(doc.get(key) or "")
            for key in ("name", "source", "record_label", "doc_type", "status")
        ).lower()
    ]


def _document_ids_matching(db: Session, model, filter_column, value: int, doc_ids: list[str]) -> set[str]:
    if not doc_ids:
        return set()
    try:
        rows = (
            db.query(model.document_id)
            .filter(filter_column == value, model.document_id.in_(doc_ids))
            .all()
        )
        return {row[0] for row in rows}
    except SQLAlchemyError:
        db.rollback()
        return set()


def _clean_document_id(document_id: str) -> str:
    clean_id = str(document_id or "").strip()
    if not clean_id or len(clean_id) > 160:
        raise HTTPException(400, "Invalid document id")
    return clean_id


def _source_key_from_document_id(document_id: str) -> str:
    clean_id = _clean_document_id(document_id)
    source_key = clean_id.split(":", 1)[0].strip().lower()
    if not source_key:
        raise HTTPException(400, "Invalid document id")
    return source_key


def _standalone_document_row_id(document_id: str) -> int | None:
    parts = _clean_document_id(document_id).split(":")
    if len(parts) < 3 or parts[0] != "standalone":
        return None
    try:
        return int(parts[2])
    except (TypeError, ValueError):
        raise HTTPException(400, "Invalid document id")


def _get_standalone_file(db: Session, document_id: str) -> DocumentManagementFile | None:
    row_id = _standalone_document_row_id(document_id)
    if row_id is None:
        return None
    record = db.query(DocumentManagementFile).filter(DocumentManagementFile.id == row_id).first()
    if not record:
        raise HTTPException(404, "Document not found")
    return record


def _parse_document_id(document_id: str) -> tuple[str, int, int, str]:
    clean_id = _clean_document_id(document_id)
    parts = clean_id.split(":", 3)
    if len(parts) != 4:
        raise HTTPException(400, "Invalid document id")
    source_key = parts[0].strip().lower()
    try:
        record_id = int(parts[1])
        row_id = int(parts[2])
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "Invalid document id") from exc
    return source_key, record_id, row_id, parts[3].strip().lower()


def _standalone_file_shared_with_user(db: Session, current_user: User, record: DocumentManagementFile) -> bool:
    try:
        document_id = _standalone_document_id(record)
        return db.query(DocumentShare.id).filter(
            DocumentShare.document_id == document_id,
            DocumentShare.shared_with == current_user.id,
        ).first() is not None
    except SQLAlchemyError:
        db.rollback()
        return False


def _standalone_file_accessible(db: Session, current_user: User, record: DocumentManagementFile) -> bool:
    shared_with_user = _standalone_file_shared_with_user(db, current_user, record)
    user_ids = _document_scope_user_ids(db, current_user)
    if user_ids is None:
        scope_allowed = True
    elif not user_ids:
        scope_allowed = shared_with_user
    else:
        owner_id = getattr(record, "uploaded_by", None)
        scope_allowed = (
            owner_id is not None and int(owner_id) in user_ids
        ) or shared_with_user

    if shared_with_user:
        return True

    return scope_allowed and _standalone_file_link_accessible(db, current_user, record)


def _query_has_accessible_row(query) -> bool:
    return query.first() is not None


def _native_document_exists(db: Session, current_user: User, document_id: str) -> bool:
    source_key, record_id, row_id, doc_type_key = _parse_document_id(document_id)
    if source_key == "standalone":
        return False
    if source_key not in SOURCE_VIEW_PERMISSION_KEYS:
        return False
    if not _user_can_view_source(db, current_user, source_key):
        return False

    if source_key == "tenders":
        query = (
            db.query(TenderDocument, Tender)
            .outerjoin(Tender, Tender.id == TenderDocument.tender_id)
            .filter(
                TenderDocument.id == row_id,
                TenderDocument.tender_id == record_id,
                TenderDocument.file_url.isnot(None),
                TenderDocument.file_url != "",
            )
        )
        query = apply_data_scope(db, query, current_user, "tenders", Tender.created_by, Tender.assigned_to)
        return _query_has_accessible_row(query)

    if source_key == "workorders":
        if "milestone" in doc_type_key:
            query = (
                db.query(WOMilestone, WorkOrder)
                .join(WorkOrder, WorkOrder.id == WOMilestone.wo_id)
                .filter(
                    WOMilestone.id == row_id,
                    WOMilestone.wo_id == record_id,
                    WOMilestone.document_url.isnot(None),
                    WOMilestone.document_url != "",
                )
            )
            query = apply_data_scope(db, query, current_user, "workorders", WorkOrder.created_by, WorkOrder.project_manager_id)
            return _query_has_accessible_row(query)

        if "invoice" in doc_type_key:
            query = (
                db.query(WOInvoice, WorkOrder)
                .join(WorkOrder, WorkOrder.id == WOInvoice.wo_id)
                .filter(
                    WOInvoice.id == row_id,
                    WOInvoice.wo_id == record_id,
                    WOInvoice.document_url.isnot(None),
                    WOInvoice.document_url != "",
                )
            )
            query = apply_data_scope(db, query, current_user, "workorders", WorkOrder.created_by, WorkOrder.project_manager_id)
            return _query_has_accessible_row(query)

        if row_id != record_id:
            return False
        if "completion" in doc_type_key:
            file_filter = and_(
                WorkOrder.completion_certificate_url.isnot(None),
                WorkOrder.completion_certificate_url != "",
            )
        elif "po" in doc_type_key:
            file_filter = or_(
                and_(WorkOrder.po_doc.isnot(None), WorkOrder.po_doc != ""),
                and_(WorkOrder.po_document_url.isnot(None), WorkOrder.po_document_url != ""),
            )
        else:
            file_filter = or_(
                and_(WorkOrder.po_doc.isnot(None), WorkOrder.po_doc != ""),
                and_(WorkOrder.po_document_url.isnot(None), WorkOrder.po_document_url != ""),
                and_(WorkOrder.completion_certificate_url.isnot(None), WorkOrder.completion_certificate_url != ""),
            )
        query = db.query(WorkOrder).filter(WorkOrder.id == record_id, file_filter)
        query = apply_data_scope(db, query, current_user, "workorders", WorkOrder.created_by, WorkOrder.project_manager_id)
        return _query_has_accessible_row(query)

    if source_key == "emdbg":
        if "renewal" in doc_type_key:
            query = (
                db.query(EMDBGRenewalHistory, EMDBG)
                .join(EMDBG, EMDBG.id == EMDBGRenewalHistory.emdbg_id)
                .filter(
                    EMDBGRenewalHistory.id == row_id,
                    EMDBGRenewalHistory.emdbg_id == record_id,
                    EMDBGRenewalHistory.renewal_document_url.isnot(None),
                    EMDBGRenewalHistory.renewal_document_url != "",
                )
            )
            query = apply_data_scope(db, query, current_user, "emdbg", EMDBG.created_by)
            return _query_has_accessible_row(query)

        if row_id != record_id:
            return False
        if "payment" in doc_type_key:
            file_filter = and_(EMDBG.payment_proof_url.isnot(None), EMDBG.payment_proof_url != "")
        elif "return" in doc_type_key:
            file_filter = and_(EMDBG.return_document_url.isnot(None), EMDBG.return_document_url != "")
        elif "release" in doc_type_key:
            file_filter = and_(EMDBG.release_document_url.isnot(None), EMDBG.release_document_url != "")
        elif "instrument" in doc_type_key:
            file_filter = and_(EMDBG.instrument_document_url.isnot(None), EMDBG.instrument_document_url != "")
        else:
            file_filter = or_(
                and_(EMDBG.instrument_document_url.isnot(None), EMDBG.instrument_document_url != ""),
                and_(EMDBG.release_document_url.isnot(None), EMDBG.release_document_url != ""),
                and_(EMDBG.payment_proof_url.isnot(None), EMDBG.payment_proof_url != ""),
                and_(EMDBG.return_document_url.isnot(None), EMDBG.return_document_url != ""),
            )
        query = db.query(EMDBG).filter(EMDBG.id == record_id, file_filter)
        query = apply_data_scope(db, query, current_user, "emdbg", EMDBG.created_by)
        return _query_has_accessible_row(query)

    if source_key == "rfp":
        if row_id != record_id:
            return False
        query = (
            db.query(RFPAnalysis, Tender)
            .outerjoin(Tender, Tender.id == RFPAnalysis.tender_id)
            .filter(
                RFPAnalysis.id == record_id,
                RFPAnalysis.document_url.isnot(None),
                RFPAnalysis.document_url != "",
            )
        )
        query = apply_data_scope(db, query, current_user, "tenders", Tender.created_by, Tender.assigned_to)
        return _query_has_accessible_row(query)

    if source_key == "travel":
        query = (
            db.query(TADAAttachment, TADAClaim)
            .join(TADAClaim, TADAClaim.id == TADAAttachment.claim_id)
            .filter(
                TADAAttachment.id == row_id,
                TADAAttachment.claim_id == record_id,
                TADAAttachment.file_url.isnot(None),
                TADAAttachment.file_url != "",
            )
        )
        query = apply_data_scope(db, query, current_user, "travel", TADAClaim.employee_id)
        return _query_has_accessible_row(query)

    return False


def _ensure_document_accessible(db: Session, current_user: User, document_id: str) -> str:
    clean_id = _clean_document_id(document_id)
    record = _get_standalone_file(db, clean_id)
    if record is not None:
        if not _standalone_file_accessible(db, current_user, record):
            raise HTTPException(404, "Document not found or not accessible")
        return clean_id

    if not _native_document_exists(db, current_user, clean_id):
        raise HTTPException(404, "Document not found or not accessible")
    return clean_id


def _standalone_document_id(record: DocumentManagementFile) -> str:
    return _document_id("standalone", record.linked_record_id, record.id, record.doc_type or "Uploaded Document")


def _trash_standalone_file(db: Session, record: DocumentManagementFile, current_user: User) -> None:
    """Mark a standalone DocumentManagementFile row as trashed (used by the single-document
    trash endpoint and by cascade folder deletion). Does not commit — caller commits."""
    clean_id = _standalone_document_id(record)
    now = datetime.utcnow()
    marker = db.query(DocumentTrash).filter(DocumentTrash.document_id == clean_id).first()
    if marker:
        marker.trashed_at = now
        marker.trashed_by = current_user.id
        marker.deleted_at = None
        marker.deleted_by = None
    else:
        db.add(DocumentTrash(document_id=clean_id, trashed_by=current_user.id, trashed_at=now))

    if record.deleted_at is None:
        record.deleted_at = now
        record.deleted_by = current_user.id


def _trash_rows_by_document_id(db: Session, doc_ids: list[str]) -> dict[str, DocumentTrash]:
    if not doc_ids:
        return {}
    try:
        rows = db.query(DocumentTrash).filter(DocumentTrash.document_id.in_(doc_ids)).all()
        return {str(row.document_id): row for row in rows}
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning("Document trash metadata skipped: %s", exc)
        return {}


def _filter_documents_by_trash_state(
    db: Session,
    documents: list[dict[str, Any]],
    *,
    trash_view: bool,
) -> list[dict[str, Any]]:
    trash_rows = _trash_rows_by_document_id(db, [str(doc.get("id") or "") for doc in documents])
    filtered: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for doc in documents:
        doc_id = str(doc.get("id") or "")
        if not doc_id or doc_id in seen_ids:
            continue
        seen_ids.add(doc_id)

        trash_row = trash_rows.get(doc_id)
        in_trash = trash_row is not None and trash_row.deleted_at is None
        permanently_deleted = trash_row is not None and trash_row.deleted_at is not None
        standalone_deleted = bool(doc.get("is_deleted"))

        if trash_view:
            if not in_trash and not standalone_deleted:
                continue
            trashed_at = trash_row.trashed_at if trash_row is not None else None
            deleted_at = _iso(trashed_at) or doc.get("deleted_at") or doc.get("updated_at")
            doc["updated_at"] = deleted_at
            doc["deleted_at"] = deleted_at
            doc["status"] = "In Trash"
            doc["is_deleted"] = True
            doc["can_trash"] = True
            if trashed_at is not None:
                doc["_sort_at"] = _sort_value(trashed_at)
            filtered.append(doc)
            continue

        if in_trash or permanently_deleted or standalone_deleted:
            continue
        doc["can_trash"] = True
        filtered.append(doc)

    return filtered


def _prepare_document_payload(
    db: Session,
    current_user: User,
    documents: list[dict[str, Any]],
    limit: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    documents.sort(key=lambda doc: doc.get("_sort_at") or datetime.min, reverse=True)
    user_ids = {int(doc["owner_id"]) for doc in documents if doc.get("owner_id") is not None}
    user_ids |= {int(doc["approval_submitted_by_id"]) for doc in documents if doc.get("approval_submitted_by_id") is not None}
    user_ids |= {int(doc["approval_decided_by_id"]) for doc in documents if doc.get("approval_decided_by_id") is not None}
    names = _user_names(db, user_ids)
    source_counts: dict[str, int] = {}

    sliced = documents[:limit]
    doc_ids = [doc["id"] for doc in sliced]
    starred_ids = _document_ids_matching(db, DocumentStar, DocumentStar.user_id, current_user.id, doc_ids)
    shared_ids = _document_ids_matching(db, DocumentShare, DocumentShare.shared_with, current_user.id, doc_ids)

    cleaned: list[dict[str, Any]] = []
    mine_count = shared_count = starred_count = 0
    for doc in sliced:
        source_key = str(doc.get("source_key") or "")
        source_counts[source_key] = source_counts.get(source_key, 0) + 1
        owner_id = doc.pop("owner_id", None)
        doc.pop("_sort_at", None)
        doc["owner"] = names.get(int(owner_id), "Unknown") if owner_id is not None else "Unknown"

        submitted_by_id = doc.pop("approval_submitted_by_id", None)
        decided_by_id = doc.pop("approval_decided_by_id", None)
        doc["approval_submitted_by"] = names.get(int(submitted_by_id)) if submitted_by_id is not None else None
        doc["approval_decided_by"] = names.get(int(decided_by_id)) if decided_by_id is not None else None

        is_mine = owner_id is not None and int(owner_id) == current_user.id
        is_starred = doc["id"] in starred_ids
        is_shared = doc["id"] in shared_ids
        doc["is_mine"] = is_mine
        doc["is_starred"] = is_starred
        doc["is_shared_with_me"] = is_shared
        if is_mine:
            mine_count += 1
        if is_shared:
            shared_count += 1
        if is_starred:
            starred_count += 1
        cleaned.append(doc)

    return cleaned, {
        "total": len(cleaned),
        "mine": mine_count,
        "shared_with_me": shared_count,
        "starred": starred_count,
        "sources": source_counts,
    }


@router.get("")
def list_documents(
    q: str | None = Query(None, max_length=120),
    source: str | None = Query(None, max_length=40),
    view: str | None = Query(None, max_length=20),
    customer_id: int | None = Query(None),
    folder_id: int | None = Query(None),
    limit: int = Query(250, ge=1, le=500),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.view")),
):
    source_filter = str(source or "").strip().lower()
    view_filter = str(view or "all").strip().lower()
    if source_filter and source_filter not in DOCUMENT_SOURCE_LABELS:
        raise HTTPException(400, "Unsupported document source")
    per_source_limit = max(limit, 100)

    documents, skipped_sources = _collect_documents(
        db,
        current_user,
        source_filter=source_filter,
        limit=per_source_limit,
        trash=view_filter == "trash",
        customer_id=customer_id,
        folder_id=folder_id,
    )

    search = str(q or "").strip().lower()
    documents = _filter_documents_by_search(documents, search)
    documents = _filter_documents_by_trash_state(db, documents, trash_view=view_filter == "trash")
    cleaned, summary = _prepare_document_payload(db, current_user, documents, limit)
    trash_count = len(documents) if view_filter == "trash" else 0

    if view_filter == "trash":
        active_documents, active_skipped = _collect_documents(
            db,
            current_user,
            source_filter=source_filter,
            limit=per_source_limit,
            trash=False,
            customer_id=customer_id,
            folder_id=folder_id,
        )
        active_documents = _filter_documents_by_search(active_documents, search)
        active_documents = _filter_documents_by_trash_state(db, active_documents, trash_view=False)
        _, active_summary = _prepare_document_payload(db, current_user, active_documents, limit)
        summary = active_summary
        skipped_sources.extend(active_skipped)
    elif view_filter == "mine":
        cleaned = [doc for doc in cleaned if doc["is_mine"]]
    elif view_filter == "shared":
        cleaned = [doc for doc in cleaned if doc["is_shared_with_me"]]
    elif view_filter == "starred":
        cleaned = [doc for doc in cleaned if doc["is_starred"]]

    if view_filter != "trash":
        trash_documents, trash_skipped = _collect_documents(
            db,
            current_user,
            source_filter=source_filter,
            limit=per_source_limit,
            trash=True,
            customer_id=customer_id,
            folder_id=folder_id,
        )
        trash_documents = _filter_documents_by_search(trash_documents, search)
        trash_documents = _filter_documents_by_trash_state(db, trash_documents, trash_view=True)
        trash_count = len(trash_documents)
        skipped_sources.extend(trash_skipped)

    return {
        "documents": cleaned,
        "summary": {
            "total": summary["total"],
            "mine": summary["mine"],
            "shared_with_me": summary["shared_with_me"],
            "starred": summary["starred"],
            "trash": trash_count,
            "sources": summary["sources"],
            "skipped_sources": sorted(set(skipped_sources)),
        },
    }


class FolderCreate(BaseModel):
    name: NonBlank("Folder name", 1, 200)  # type: ignore[valid-type]
    parent_id: int | None = None


class FolderRename(BaseModel):
    name: NonBlank("Folder name", 1, 200)  # type: ignore[valid-type]


def _folder_name_key(name: str | None) -> str:
    return " ".join(str(name or "").strip().split()).casefold()


def _folder_name_taken(
    db: Session,
    current_user: User,
    *,
    name: str,
    parent_id: int | None,
    exclude_id: int | None = None,
) -> bool:
    target_name = _folder_name_key(name)
    query = db.query(DocumentFolder).filter(
        DocumentFolder.owner_id == current_user.id,
        DocumentFolder.parent_id == parent_id,
    )
    if exclude_id is not None:
        query = query.filter(DocumentFolder.id != exclude_id)
    return any(_folder_name_key(row.name) == target_name for row in query.all())


def _folder_ancestor_name_taken(
    db: Session,
    current_user: User,
    *,
    name: str,
    parent_id: int | None,
) -> bool:
    target_name = _folder_name_key(name)
    seen: set[int] = set()
    current_parent_id = parent_id

    while current_parent_id is not None and current_parent_id not in seen:
        seen.add(current_parent_id)
        parent = (
            db.query(DocumentFolder)
            .filter(DocumentFolder.id == current_parent_id, DocumentFolder.owner_id == current_user.id)
            .first()
        )
        if not parent:
            break
        if _folder_name_key(parent.name) == target_name:
            return True
        current_parent_id = parent.parent_id

    return False


def _folder_descendant_name_taken(
    db: Session,
    current_user: User,
    *,
    name: str,
    folder_id: int,
) -> bool:
    target_name = _folder_name_key(name)
    rows = db.query(DocumentFolder).filter(DocumentFolder.owner_id == current_user.id).all()
    children_by_parent: dict[int, list[DocumentFolder]] = {}
    for row in rows:
        if row.parent_id is not None:
            children_by_parent.setdefault(row.parent_id, []).append(row)

    stack = list(children_by_parent.get(folder_id, []))
    seen: set[int] = set()
    while stack:
        child = stack.pop()
        if child.id in seen:
            continue
        seen.add(child.id)
        if _folder_name_key(child.name) == target_name:
            return True
        stack.extend(children_by_parent.get(child.id, []))

    return False


def _validate_folder_name_available(
    db: Session,
    current_user: User,
    *,
    name: str,
    parent_id: int | None,
    exclude_id: int | None = None,
    check_descendants_of: int | None = None,
) -> None:
    if _folder_name_taken(db, current_user, name=name, parent_id=parent_id, exclude_id=exclude_id):
        raise field_error("name", f'A folder named "{name}" already exists here.', 409)

    if _folder_ancestor_name_taken(db, current_user, name=name, parent_id=parent_id):
        raise field_error("name", f'A parent folder already uses "{name}". Please choose a different subfolder name.', 409)

    if check_descendants_of is not None and _folder_descendant_name_taken(
        db,
        current_user,
        name=name,
        folder_id=check_descendants_of,
    ):
        raise field_error("name", f'A subfolder already uses "{name}". Please choose a different folder name.', 409)


@router.get("/folders")
def list_folders(
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.view")),
):
    rows = (
        db.query(DocumentFolder)
        .filter(DocumentFolder.owner_id == current_user.id)
        .order_by(DocumentFolder.name.asc())
        .all()
    )
    return {
        "folders": [
            {"id": row.id, "name": row.name, "parent_id": row.parent_id, "created_at": _iso(row.created_at)}
            for row in rows
        ]
    }


@router.post("/folders", status_code=201)
def create_folder(
    payload: FolderCreate,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.create")),
):
    name = payload.name.strip()[:200]
    if not name:
        raise HTTPException(400, "Folder name is required")

    if payload.parent_id is not None:
        parent = (
            db.query(DocumentFolder)
            .filter(DocumentFolder.id == payload.parent_id, DocumentFolder.owner_id == current_user.id)
            .first()
        )
        if not parent:
            raise HTTPException(404, "Parent folder not found")

    _validate_folder_name_available(db, current_user, name=name, parent_id=payload.parent_id)

    folder = DocumentFolder(name=name, parent_id=payload.parent_id, owner_id=current_user.id)
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return {"id": folder.id, "name": folder.name, "parent_id": folder.parent_id}


@router.put("/folders/{folder_id}")
def rename_folder(
    folder_id: int,
    payload: FolderRename,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.update")),
):
    folder = (
        db.query(DocumentFolder)
        .filter(DocumentFolder.id == folder_id, DocumentFolder.owner_id == current_user.id)
        .first()
    )
    if not folder:
        raise HTTPException(404, "Folder not found")

    name = payload.name.strip()[:200]
    if not name:
        raise HTTPException(400, "Folder name is required")

    _validate_folder_name_available(
        db,
        current_user,
        name=name,
        parent_id=folder.parent_id,
        exclude_id=folder.id,
        check_descendants_of=folder.id,
    )

    folder.name = name
    db.commit()
    return {"id": folder.id, "name": folder.name, "parent_id": folder.parent_id}


@router.delete("/folders/{folder_id}")
def delete_folder(
    folder_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.delete")),
):
    """Cascade delete: removes this folder and every subfolder, and moves any
    files filed inside them to Trash (not a permanent delete)."""
    folder = (
        db.query(DocumentFolder)
        .filter(DocumentFolder.id == folder_id, DocumentFolder.owner_id == current_user.id)
        .first()
    )
    if not folder:
        raise HTTPException(404, "Folder not found")

    all_folders = db.query(DocumentFolder).filter(DocumentFolder.owner_id == current_user.id).all()
    children_by_parent: dict[int, list[DocumentFolder]] = {}
    for f in all_folders:
        if f.parent_id is not None:
            children_by_parent.setdefault(f.parent_id, []).append(f)

    to_delete: list[DocumentFolder] = []
    stack = [folder]
    while stack:
        current = stack.pop()
        to_delete.append(current)
        stack.extend(children_by_parent.get(current.id, []))

    folder_ids = [f.id for f in to_delete]

    files = (
        db.query(DocumentManagementFile)
        .filter(
            DocumentManagementFile.folder_id.in_(folder_ids),
            DocumentManagementFile.deleted_at.is_(None),
        )
        .all()
    )
    for record in files:
        _trash_standalone_file(db, record, current_user)

    for f in reversed(to_delete):
        db.delete(f)

    db.commit()
    return {"id": folder_id, "deleted": True, "trashed_files": len(files)}


class DocumentStarRequest(BaseModel):
    document_id: str


class DocumentShareRequest(BaseModel):
    document_id: str
    user_ids: list[int] = []


class DocumentMoveRequest(BaseModel):
    folder_id: int | None = None


@router.get("/link-options")
def list_link_options(
    source: str = Query(..., max_length=40),
    q: str | None = Query(None, max_length=120),
    limit: int = Query(25, ge=1, le=50),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.view")),
):
    source_key = str(source or "").strip().lower()
    if source_key == "standalone":
        return {"records": []}
    if source_key not in LINKABLE_SOURCES:
        raise HTTPException(400, "Unsupported link source")
    return {
        "records": _link_record_options(
            db,
            current_user,
            source_key,
            search=str(q or "").strip(),
            limit=limit,
        )
    }


@router.post("/{document_id:path}/move")
def move_document_to_folder(
    document_id: str,
    payload: DocumentMoveRequest,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.update")),
):
    clean_id = _ensure_document_accessible(db, current_user, document_id)
    record = _get_standalone_file(db, clean_id)
    if record is None:
        raise HTTPException(400, "Only uploaded documents can be moved to folders")
    if record.deleted_at is not None:
        raise HTTPException(400, "Restore the document before moving it")
    if int(record.uploaded_by or 0) != int(current_user.id):
        raise HTTPException(403, "Only the document owner can move it")

    if payload.folder_id is not None:
        folder = (
            db.query(DocumentFolder)
            .filter(DocumentFolder.id == payload.folder_id, DocumentFolder.owner_id == current_user.id)
            .first()
        )
        if not folder:
            raise HTTPException(404, "Folder not found")

    record.folder_id = payload.folder_id
    db.commit()
    return {"document_id": clean_id, "folder_id": record.folder_id}


@router.post("/{document_id:path}/trash")
def move_document_to_trash(
    document_id: str,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.delete")),
):
    clean_id = _ensure_document_accessible(db, current_user, document_id)
    record = _get_standalone_file(db, clean_id)
    if _source_key_from_document_id(clean_id) == "standalone" and record is None:
        raise HTTPException(404, "Document not found")

    if record is not None:
        _trash_standalone_file(db, record, current_user)
    else:
        now = datetime.utcnow()
        marker = db.query(DocumentTrash).filter(DocumentTrash.document_id == clean_id).first()
        if marker:
            marker.trashed_at = now
            marker.trashed_by = current_user.id
            marker.deleted_at = None
            marker.deleted_by = None
        else:
            db.add(DocumentTrash(document_id=clean_id, trashed_by=current_user.id, trashed_at=now))

    db.commit()
    return {"document_id": clean_id, "trashed": True}


@router.post("/{document_id:path}/restore")
def restore_document_from_trash(
    document_id: str,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.update")),
):
    clean_id = _ensure_document_accessible(db, current_user, document_id)
    record = _get_standalone_file(db, clean_id)
    marker = db.query(DocumentTrash).filter(DocumentTrash.document_id == clean_id).first()

    if marker is None and not (record is not None and record.deleted_at is not None):
        raise HTTPException(404, "Document is not in Trash")

    if marker is not None:
        db.delete(marker)
    if record is not None and record.deleted_at is not None:
        record.deleted_at = None
        record.deleted_by = None

    db.commit()
    return {"document_id": clean_id, "restored": True}


class DocumentApprovalDecision(BaseModel):
    comment: str | None = None


class DocumentRejectionDecision(BaseModel):
    reason: str


def _load_approvable_standalone_file(db: Session, current_user: User, document_id: str) -> tuple[str, DocumentManagementFile]:
    clean_id = _ensure_document_accessible(db, current_user, document_id)
    record = _get_standalone_file(db, clean_id)
    if record is None:
        raise HTTPException(400, "Only uploaded documents support the approval workflow")
    if record.deleted_at is not None:
        raise HTTPException(400, "Document is in Trash")
    return clean_id, record


@router.post("/{document_id:path}/submit-approval")
def submit_document_for_approval(
    document_id: str,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.create")),
):
    clean_id, record = _load_approvable_standalone_file(db, current_user, document_id)
    if record.uploaded_by != current_user.id:
        raise HTTPException(403, "Only the document owner can submit it for approval")

    current_status = record.approval_status or "uploaded"
    if current_status not in ("uploaded", "rejected"):
        raise HTTPException(400, "Document is already submitted or approved")

    record.approval_status = "pending_approval"
    record.submitted_by = current_user.id
    record.submitted_at = datetime.utcnow()
    record.approval_decided_by = None
    record.approval_decided_at = None
    record.approval_comment = None
    db.commit()
    return {"document_id": clean_id, "approval_status": record.approval_status}


@router.post("/{document_id:path}/approve")
def approve_document(
    document_id: str,
    payload: DocumentApprovalDecision,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.approve")),
):
    clean_id, record = _load_approvable_standalone_file(db, current_user, document_id)
    if (record.approval_status or "uploaded") != "pending_approval":
        raise HTTPException(400, "Document is not pending approval")

    record.approval_status = "approved"
    record.approval_decided_by = current_user.id
    record.approval_decided_at = datetime.utcnow()
    record.approval_comment = (payload.comment or "").strip()[:1000] or None
    db.commit()
    return {"document_id": clean_id, "approval_status": record.approval_status}


@router.post("/{document_id:path}/reject")
def reject_document(
    document_id: str,
    payload: DocumentRejectionDecision,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.approve")),
):
    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(400, "A rejection reason is required")

    clean_id, record = _load_approvable_standalone_file(db, current_user, document_id)
    if (record.approval_status or "uploaded") != "pending_approval":
        raise HTTPException(400, "Document is not pending approval")

    record.approval_status = "rejected"
    record.approval_decided_by = current_user.id
    record.approval_decided_at = datetime.utcnow()
    record.approval_comment = reason[:1000]
    db.commit()
    return {"document_id": clean_id, "approval_status": record.approval_status}


@router.delete("/{document_id:path}")
def permanently_delete_document(
    document_id: str,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.delete")),
):
    clean_id = _ensure_document_accessible(db, current_user, document_id)
    record = _get_standalone_file(db, clean_id)
    marker = db.query(DocumentTrash).filter(DocumentTrash.document_id == clean_id).first()
    in_trash = bool(marker and marker.deleted_at is None) or bool(record and record.deleted_at is not None)
    if not in_trash:
        raise HTTPException(400, "Move the document to Trash before permanent deletion")

    db.query(DocumentShare).filter(DocumentShare.document_id == clean_id).delete(synchronize_session=False)
    db.query(DocumentStar).filter(DocumentStar.document_id == clean_id).delete(synchronize_session=False)

    file_url = record.file_url if record is not None else None
    if record is not None:
        db.delete(record)
        if marker is not None:
            db.delete(marker)
    elif marker is not None:
        marker.deleted_at = datetime.utcnow()
        marker.deleted_by = current_user.id

    db.commit()

    if file_url:
        try:
            delete_stored_file(media_url_to_logical_path(root_dir=os.path.abspath(MEDIA_ROOT), file_url=file_url))
        except Exception:
            logger.warning("Failed to delete document-management file: %s", file_url, exc_info=True)

    return {"document_id": clean_id, "deleted": True}


@router.post("/upload", status_code=201)
async def upload_document(
    request: Request,
    file: UploadFile = File(...),
    name: str | None = Form(None),
    description: str | None = Form(None),
    linked_source: str | None = Form(None),
    linked_record_id: int | None = Form(None),
    doc_type: str | None = Form(None),
    folder_id: int | None = Form(None),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.create")),
):
    ext = os.path.splitext(file.filename or "")[-1].lower()
    if ext not in ALLOWED_UPLOAD_EXTENSIONS:
        raise field_error("file", f"File type '{ext}' not allowed.", 400)

    # optional text fields: validated only when filled (blank falls back to the file name / default type)
    for key, val, label, limit in (("name", name, "Name", 300), ("doc_type", doc_type, "Document type", 120),
                                   ("description", description, "Description", 500)):
        if val is not None and len(val.strip()) > limit:
            raise field_error(key, f"{label} cannot exceed {limit} characters.")

    contents = await file.read()
    if not contents:
        raise field_error("file", "Uploaded file is empty", 400)

    if folder_id is not None:
        folder = (
            db.query(DocumentFolder)
            .filter(DocumentFolder.id == folder_id, DocumentFolder.owner_id == current_user.id)
            .first()
        )
        if not folder:
            raise HTTPException(404, "Folder not found")

    linked_record = _resolve_linked_record(db, current_user, linked_source, linked_record_id)
    clean_linked_source = linked_record["source_key"] if linked_record else None
    clean_doc_type = (doc_type or "Uploaded Document").strip()[:120] or "Uploaded Document"

    saved = save_upload_optimized(
        root_dir=os.path.abspath(MEDIA_ROOT),
        subfolder="document-management",
        original_filename=file.filename,
        contents=contents,
        media_slug=media_slug_from_request(request),
        content_type=file.content_type,
        force_compression=True,
    )

    record = DocumentManagementFile(
        name=(name or file.filename or "Document").strip()[:300],
        description=(description or "").strip()[:500] or None,
        file_url=saved.url,
        file_size_kb=saved.size_kb,
        uploaded_by=current_user.id,
        linked_source=clean_linked_source,
        linked_record_id=linked_record["id"] if linked_record else None,
        linked_record_label=linked_record["label"] if linked_record else None,
        doc_type=clean_doc_type,
        folder_id=folder_id,
    )
    db.add(record)
    db.flush()
    log_module_action(
        db=db, user_id=current_user.id, module="document_management", action="upload",
        record_id=record.id, record_name=record.name, ip=get_request_ip(request),
        new_data={"doc_type": record.doc_type, "file_size_kb": record.file_size_kb, "linked_source": record.linked_source},
    )
    db.commit()
    db.refresh(record)

    return {
        "message": "Uploaded",
        "id": record.id,
        "document_id": _standalone_document_id(record),
        "file_url": record.file_url,
        "file_size_kb": record.file_size_kb,
        "file_type": _file_extension(record.name, record.file_url).upper(),
        "compression_type": saved.compression_type,
        "stored_in": "document_management_files",
        "linked_source": record.linked_source,
        "linked_record_id": record.linked_record_id,
        "linked_record_label": record.linked_record_label,
        "doc_type": record.doc_type,
    }


@router.post("/star")
def toggle_document_star(
    payload: DocumentStarRequest,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("document_management.view")),
):
    document_id = _ensure_document_accessible(db, current_user, payload.document_id)
    if not document_id:
        raise HTTPException(400, "document_id is required")

    existing = db.query(DocumentStar).filter(
        DocumentStar.document_id == document_id,
        DocumentStar.user_id == current_user.id,
    ).first()

    if existing:
        db.delete(existing)
        db.commit()
        return {"document_id": document_id, "starred": False}

    db.add(DocumentStar(document_id=document_id, user_id=current_user.id))
    db.commit()
    return {"document_id": document_id, "starred": True}


@router.get("/shares")
def get_document_shares(
    document_id: str = Query(..., max_length=160),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    clean_id = _ensure_document_accessible(db, current_user, document_id)
    rows = db.query(DocumentShare).filter(DocumentShare.document_id == clean_id).all()
    user_ids = {row.shared_with for row in rows}
    names = _user_names(db, user_ids)
    return {
        "document_id": clean_id,
        "shared_with": [{"id": uid, "name": names.get(uid, "Unknown")} for uid in user_ids],
    }


@router.post("/share")
def share_document(
    payload: DocumentShareRequest,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    document_id = _ensure_document_accessible(db, current_user, payload.document_id)
    if not document_id:
        raise HTTPException(400, "document_id is required")

    target_ids = {int(uid) for uid in payload.user_ids if int(uid) != current_user.id}

    existing_rows = db.query(DocumentShare).filter(DocumentShare.document_id == document_id).all()
    existing_ids = {row.shared_with for row in existing_rows}

    for row in existing_rows:
        if row.shared_with not in target_ids:
            db.delete(row)
    for uid in target_ids - existing_ids:
        db.add(DocumentShare(document_id=document_id, shared_by=current_user.id, shared_with=uid))

    db.commit()
    names = _user_names(db, target_ids)
    return {
        "document_id": document_id,
        "shared_with": [{"id": uid, "name": names.get(uid, "Unknown")} for uid in target_ids],
    }
