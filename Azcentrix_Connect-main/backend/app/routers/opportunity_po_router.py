"""
opportunity_po_router.py — PO details for the Direct Opportunity flow
=====================================================================
GET  /opportunity-po/{lead_id}               → get PO details (or null)
POST /opportunity-po/{lead_id}               → upsert PO details + optional file upload
GET  /opportunity-po/{lead_id}/po-doc        → stream / preview the PO document
GET  /opportunity-po/{lead_id}/po-doc/download → force-download PO document

Stored in  opportunity_po_details  table (lead_id unique key).
PO document saved to same  <MEDIA_ROOT>/<tenant>/po/  folder as workorders.
Uses /preview/file and /preview/download for client-side preview/download.
"""

import os
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.dependencies import get_tenant_db, get_current_user, require_permission
from app.models.all_models import Lead, User
from app.utils.data_scope import apply_data_scope
from app.utils.file_storage import (
    save_upload_optimized,
    open_stored_file,
    iter_file_chunks,
    media_slug_from_request,
    media_url_to_logical_path,
    stored_file_headers,
)
from app.core.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


def _ensure_opportunity_in_scope(db: Session, user: User, lead_id: int) -> None:
    """404 when the parent opportunity is outside the user's Opportunities
    data-visibility scope."""
    q = db.query(Lead.id).filter(Lead.id == lead_id)
    if not apply_data_scope(db, q, user, "opportunity", Lead.created_by, Lead.assigned_to).first():
        raise HTTPException(404, "Opportunity not found")


def _media_root() -> str:
    root = getattr(settings, "MEDIA_ROOT", None) or os.environ.get("MEDIA_ROOT", "media")
    return os.path.abspath(root)


class StatusUpdateIn(BaseModel):
    wo_status: str = "Draft"
    progress_percent: int = 0


def _serialize_po(row) -> dict:
    return {
        "id":                  row.id,
        "lead_id":             row.lead_id,
        "wo_type":             row.wo_type or "Supply",
        "customer_name":       row.customer_name or "",
        "project_title":       row.project_title or "",
        "po_number":           row.po_number or "",
        "po_date":             str(row.po_date) if row.po_date else None,
        "po_value":            float(row.po_value or 0),
        "wo_value":            float(row.wo_value or 0),
        "warranty_months":     int(row.warranty_months or 12),
        "delivery_date":       str(row.delivery_date) if row.delivery_date else None,
        "installation_date":   str(row.installation_date) if row.installation_date else None,
        "site_location":       row.site_location or "",
        "site_engineer":       row.site_engineer,
        "site_engineer_phone": row.site_engineer_phone or "",
        "advance_percent":     float(row.advance_percent or 0),
        "retention_percent":   float(row.retention_percent or 0),
        "payment_terms":       row.payment_terms or "",
        "scope_of_work":       row.scope_of_work or "",
        "po_doc":              row.po_doc or None,
        "wo_status":           getattr(row, "wo_status", None) or "Draft",
        "progress_percent":    int(getattr(row, "progress_percent", 0) or 0),
        "created_at":          str(row.created_at) if row.created_at else None,
        "updated_at":          str(row.updated_at) if row.updated_at else None,
    }


# ─── GET /{lead_id} ───────────────────────────────────────────────────────────

@router.get("/{lead_id}/po-doc")
def preview_po_doc(
    lead_id: int,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("opportunities.view")),
):
    _ensure_opportunity_in_scope(db, current_user, lead_id)
    row = db.execute(
        text("SELECT po_doc FROM opportunity_po_details WHERE lead_id = :lid"),
        {"lid": lead_id},
    ).fetchone()
    if not row or not row.po_doc:
        raise HTTPException(404, "No PO document found")

    logical = str(media_url_to_logical_path(root_dir=_media_root(), file_url=row.po_doc))
    try:
        file_obj, _, _ = open_stored_file(logical)
    except FileNotFoundError:
        raise HTTPException(404, "PO document file not found on server")

    content_type, headers = stored_file_headers(
        logical_path=logical,
        disposition="inline",
        download_name=os.path.basename(logical),
    )
    return StreamingResponse(iter_file_chunks(file_obj), media_type=content_type, headers=headers)


@router.get("/{lead_id}/po-doc/download")
def download_po_doc(
    lead_id: int,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("opportunities.view")),
):
    _ensure_opportunity_in_scope(db, current_user, lead_id)
    row = db.execute(
        text("SELECT po_doc FROM opportunity_po_details WHERE lead_id = :lid"),
        {"lid": lead_id},
    ).fetchone()
    if not row or not row.po_doc:
        raise HTTPException(404, "No PO document found")

    logical = str(media_url_to_logical_path(root_dir=_media_root(), file_url=row.po_doc))
    try:
        file_obj, _, _ = open_stored_file(logical)
    except FileNotFoundError:
        raise HTTPException(404, "PO document file not found on server")

    ext = os.path.splitext(logical)[1].lower()
    content_type, headers = stored_file_headers(
        logical_path=logical,
        disposition="attachment",
        download_name=f"PO-opportunity-{lead_id}{ext}",
    )
    return StreamingResponse(iter_file_chunks(file_obj), media_type=content_type, headers=headers)


@router.get("/{lead_id}")
def get_po(
    lead_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("opportunities.view")),
):
    _ensure_opportunity_in_scope(db, current_user, lead_id)
    row = db.execute(
        text("SELECT * FROM opportunity_po_details WHERE lead_id = :lid"),
        {"lid": lead_id},
    ).fetchone()
    if not row:
        return None
    return _serialize_po(row)


# ─── POST /{lead_id}  (upsert + optional file upload) ────────────────────────

@router.post("/{lead_id}")
async def save_po(
    lead_id: int,
    request: Request,
    wo_type: str = Form("Supply"),
    customer_name: str = Form(""),
    project_title: str = Form(""),
    po_number: str = Form(""),
    po_date: Optional[str] = Form(None),
    po_value: float = Form(0),
    wo_value: float = Form(0),
    warranty_months: int = Form(12),
    delivery_date: Optional[str] = Form(None),
    installation_date: Optional[str] = Form(None),
    site_location: str = Form(""),
    site_engineer: Optional[int] = Form(None),
    site_engineer_phone: str = Form(""),
    advance_percent: float = Form(0),
    retention_percent: float = Form(0),
    payment_terms: str = Form(""),
    scope_of_work: str = Form(""),
    po_doc_file: Optional[UploadFile] = File(None),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("opportunities.update")),
):
    _ensure_opportunity_in_scope(db, current_user, lead_id)
    existing = db.execute(
        text("SELECT id, po_doc FROM opportunity_po_details WHERE lead_id = :lid"),
        {"lid": lead_id},
    ).fetchone()

    po_doc_path = existing.po_doc if existing else None

    if po_doc_file and po_doc_file.filename:
        contents = await po_doc_file.read()
        if contents:
            saved = save_upload_optimized(
                root_dir=_media_root(),
                subfolder="po",
                original_filename=po_doc_file.filename,
                contents=contents,
                media_slug=media_slug_from_request(request),
            )
            po_doc_path = saved.url

    params: dict = {
        "wo_type":             wo_type or "Supply",
        "customer_name":       customer_name or "",
        "project_title":       project_title or "",
        "po_number":           po_number or "",
        "po_date":             po_date or None,
        "po_value":            po_value or 0,
        "wo_value":            wo_value or 0,
        "warranty_months":     warranty_months or 12,
        "delivery_date":       delivery_date or None,
        "installation_date":   installation_date or None,
        "site_location":       site_location or "",
        "site_engineer":       site_engineer,
        "site_engineer_phone": site_engineer_phone or "",
        "advance_percent":     advance_percent or 0,
        "retention_percent":   retention_percent or 0,
        "payment_terms":       payment_terms or "",
        "scope_of_work":       scope_of_work or "",
        "po_doc":              po_doc_path,
        "lead_id":             lead_id,
    }

    if existing:
        db.execute(text("""
            UPDATE opportunity_po_details SET
                wo_type = :wo_type, customer_name = :customer_name,
                project_title = :project_title, po_number = :po_number,
                po_date = :po_date, po_value = :po_value, wo_value = :wo_value,
                warranty_months = :warranty_months, delivery_date = :delivery_date,
                installation_date = :installation_date, site_location = :site_location,
                site_engineer = :site_engineer, site_engineer_phone = :site_engineer_phone,
                advance_percent = :advance_percent, retention_percent = :retention_percent,
                payment_terms = :payment_terms, scope_of_work = :scope_of_work,
                po_doc = :po_doc, updated_at = NOW()
            WHERE lead_id = :lead_id
        """), params)
    else:
        db.execute(text("""
            INSERT INTO opportunity_po_details
                (lead_id, wo_type, customer_name, project_title, po_number, po_date,
                 po_value, wo_value, warranty_months, delivery_date, installation_date,
                 site_location, site_engineer, site_engineer_phone, advance_percent,
                 retention_percent, payment_terms, scope_of_work, po_doc, created_by, created_at)
            VALUES
                (:lead_id, :wo_type, :customer_name, :project_title, :po_number, :po_date,
                 :po_value, :wo_value, :warranty_months, :delivery_date, :installation_date,
                 :site_location, :site_engineer, :site_engineer_phone, :advance_percent,
                 :retention_percent, :payment_terms, :scope_of_work, :po_doc, :created_by, NOW())
        """), {**params, "created_by": current_user.id})

    db.commit()

    row = db.execute(
        text("SELECT * FROM opportunity_po_details WHERE lead_id = :lid"),
        {"lid": lead_id},
    ).fetchone()
    return _serialize_po(row)


# ─── PATCH /{lead_id}/status  (update wo_status + progress_percent) ──────────

@router.patch("/{lead_id}/status")
def update_status(
    lead_id: int,
    body: StatusUpdateIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("opportunities.update")),
):
    _ensure_opportunity_in_scope(db, current_user, lead_id)
    existing = db.execute(
        text("SELECT id FROM opportunity_po_details WHERE lead_id = :lid"),
        {"lid": lead_id},
    ).fetchone()
    if not existing:
        raise HTTPException(404, "PO details not found for this opportunity")

    db.execute(text("""
        UPDATE opportunity_po_details
           SET wo_status = :wo_status,
               progress_percent = :progress_percent,
               updated_at = NOW()
         WHERE lead_id = :lead_id
    """), {
        "wo_status":        body.wo_status,
        "progress_percent": max(0, min(100, body.progress_percent)),
        "lead_id":          lead_id,
    })
    db.commit()

    row = db.execute(
        text("SELECT * FROM opportunity_po_details WHERE lead_id = :lid"),
        {"lid": lead_id},
    ).fetchone()
    return _serialize_po(row)
