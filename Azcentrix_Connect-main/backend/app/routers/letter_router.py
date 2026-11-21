"""Letter Management router — letter types (categories), reusable templates
(with a trash bin), and issued letters (with attachments + history)."""
import logging
import os
from datetime import date, datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from sqlalchemy.orm import Session

from app.core.timezone import now_ist
from app.dependencies import get_tenant_db, get_current_user, get_request_ip, require_permission
from app.core.logging import model_snapshot
from app.models.all_models import (
    LetterType,
    LetterTemplate,
    Letter,
    LetterDocument,
    LetterHistory,
    AuditLog,
    DocumentManagementFile,
    Quotation,
    User,
)
from app.utils.file_storage import media_slug_from_request, save_upload_optimized
from app.core.validators import Email, NonBlank, OptText, SaneDate, field_error
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter()

MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "media")
# Document Hub doc_type for the PDF saved when a letter is issued.
ISSUED_LETTER_DOC_TYPE = "Issued Letter"
def _sync_issued_letter_to_quotation(db: Session, letter: Letter, current_user: User) -> Quotation:
    """Create one quotation-register entry for an issued letter."""
    from app.routers.quotation_router import _ensure_quotation_runtime_schema
    _ensure_quotation_runtime_schema(db)
    quotation = db.query(Quotation).filter(Quotation.letter_id == letter.id).first()
    if quotation:
        return quotation
    # Link a letter issued for an existing quotation instead of duplicating it.
    if letter.linked_source == "quotation" and letter.linked_record_id:
        quotation = db.query(Quotation).filter(Quotation.id == letter.linked_record_id).first()
        if quotation:
            quotation.letter_id = letter.id
            db.flush()
            return quotation
    quotation = Quotation(
        letter_id=letter.id,
        customer_id=letter.linked_record_id if letter.linked_source == "customer" else None,
        quotation_number=letter.letter_no or f"LTR-{letter.id}",
        revision_number=1,
        subject=letter.subject or letter.title,
        amount=0, tax_amount=0, total_amount=0,
        status="Sent",
        notes=f"Issued from Letter Management: {letter.letter_no or letter.id}",
        ref_number=letter.letter_no or "",
        customer_to_name=letter.recipient_name or "",
        customer_address_text=letter.recipient_address or "",
        created_by=current_user.id,
    )
    db.add(quotation)
    db.flush()
    return quotation


# ─── Schemas ────────────────────────────────────────────────────────────────

class LetterTypeIn(BaseModel):
    key: NonBlank("Key", 1, 100)  # type: ignore[valid-type]
    name: NonBlank("Name", 2, 200)  # type: ignore[valid-type]
    description: OptText("Description", 2000) = None  # type: ignore[valid-type]
    is_active: bool = True
    sort_order: int = Field(0, ge=0, le=100000)


class LetterTemplateIn(BaseModel):
    name: NonBlank("Template name", 2, 200)  # type: ignore[valid-type]
    category: OptText("Source module", 200) = None   # letter type name — resolved/created by name  # type: ignore[valid-type]
    folder: OptText("Template folder", 200) = None  # type: ignore[valid-type]
    description: OptText("Description", 2000) = None  # type: ignore[valid-type]
    subject: OptText("Subject", 300) = None  # type: ignore[valid-type]
    template_body: str  # blank body is checked on the form; kept loose so status toggles on old templates still work
    variables: List[str] = []
    is_default: bool = False
    is_active: bool = True


class LetterCreate(BaseModel):
    letter_type_id: Optional[int] = None
    letter_template_id: Optional[int] = None
    title: NonBlank("Title", 1, 300)  # type: ignore[valid-type]
    subject: OptText("Subject", 300) = None  # type: ignore[valid-type]
    body: Optional[str] = None
    linked_source: Optional[str] = Field(None, max_length=40)
    linked_record_id: Optional[int] = None
    linked_record_label: OptText("Linked record", 300) = None  # type: ignore[valid-type]
    recipient_name: OptText("Recipient name", 200) = None  # type: ignore[valid-type]
    recipient_email: Email = None
    recipient_address: OptText("Recipient address", 2000) = None  # type: ignore[valid-type]
    issue_date: SaneDate = None


class LetterUpdate(BaseModel):
    title: NonBlank("Title", 1, 300) = None  # type: ignore[valid-type]  # omitted = unchanged; blank is rejected
    subject: OptText("Subject", 300) = None  # type: ignore[valid-type]
    body: Optional[str] = None
    recipient_name: OptText("Recipient name", 200) = None  # type: ignore[valid-type]
    recipient_email: Email = None
    recipient_address: OptText("Recipient address", 2000) = None  # type: ignore[valid-type]
    issue_date: SaneDate = None
    status: Optional[str] = None


class LetterDocumentIn(BaseModel):
    doc_type: OptText("Document type", 120) = None  # type: ignore[valid-type]
    file_name: NonBlank("File name", 1, 300)  # type: ignore[valid-type]
    file_url: NonBlank("File", 1, 500)  # type: ignore[valid-type]
    file_size_kb: Optional[int] = None
    mime_type: Optional[str] = None


# ─── Helpers ────────────────────────────────────────────────────────────────

def require_template_admin(current_user: User = Depends(get_current_user)) -> User:
    """Template/category management (create, edit, duplicate, delete, trash)
    is restricted to the Admin role only, regardless of a role's configured
    letter_management permissions. Other roles keep viewing templates and
    generating/managing their own letters via letter_management.* below."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Only Admin can manage letter templates")
    return current_user


def _get_or_create_letter_type(db: Session, name: Optional[str], current_user: User) -> Optional[int]:
    name = (name or "").strip()
    if not name:
        return None
    key = name.lower().strip().replace(" ", "_")
    letter_type = db.query(LetterType).filter(LetterType.key == key).first()
    if letter_type:
        return letter_type.id
    letter_type = LetterType(key=key, name=name, created_by=current_user.id, updated_by=current_user.id)
    db.add(letter_type)
    db.flush()
    return letter_type.id


def _type_name(db: Session, letter_type_id: Optional[int]) -> str:
    if not letter_type_id:
        return "General"
    letter_type = db.query(LetterType).filter(LetterType.id == letter_type_id).first()
    return letter_type.name if letter_type else "General"


def _template_out(db: Session, t: LetterTemplate) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "category": _type_name(db, t.letter_type_id),
        "folder": t.folder or "",
        "description": t.description or "",
        "subject": t.subject or "",
        "template_body": t.template_body,
        "variables": t.variables or [],
        "version": t.version,
        "is_default": t.is_default,
        "is_active": t.is_active,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": (t.updated_at or t.created_at).isoformat() if (t.updated_at or t.created_at) else None,
    }


def _trash_out(db: Session, t: LetterTemplate) -> dict:
    return {
        "id": t.id,
        "original_id": t.id,
        "title": t.name,
        "subtitle": f"v{t.version}.0 · Subject: {t.subject or 'N/A'}",
        "category": _type_name(db, t.letter_type_id),
        "deleted_at": t.deleted_at.isoformat() if t.deleted_at else None,
        "data": _template_out(db, t),
    }


def _get_active_template(db: Session, template_id: int) -> LetterTemplate:
    t = db.query(LetterTemplate).filter(
        LetterTemplate.id == template_id, LetterTemplate.is_deleted == False
    ).first()
    if not t:
        raise HTTPException(status_code=404, detail="Letter template not found")
    return t

def _get_letter(db: Session, letter_id: int) -> Letter:
    letter = db.query(Letter).filter(Letter.id == letter_id, Letter.is_deleted == False).first()
    if not letter:
        raise HTTPException(status_code=404, detail="Letter not found")
    return letter


def _record_history(
    db: Session,
    letter_id: int,
    action: str,
    current_user: User,
    from_status: Optional[str] = None,
    to_status: Optional[str] = None,
    remarks: Optional[str] = None,
    old_data: Optional[dict] = None,
    new_data: Optional[dict] = None,
):
    db.add(LetterHistory(
        letter_id=letter_id,
        action=action,
        from_status=from_status,
        to_status=to_status,
        remarks=remarks,
        old_data=old_data,
        new_data=new_data,
        performed_by=current_user.id,
    ))


# ─── Letter Types (categories) ──────────────────────────────────────────────

@router.get("/types")
def list_letter_types(
    db: Session = Depends(get_tenant_db),
    _: User = Depends(require_permission("letter_management.view")),
):
    types = db.query(LetterType).order_by(LetterType.sort_order, LetterType.name).all()
    return types


@router.post("/types", status_code=201)
def create_letter_type(
    data: LetterTypeIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_template_admin),
):
    existing = db.query(LetterType).filter(LetterType.key == data.key.strip().lower()).first()
    if existing:
        raise field_error("key", f"A letter type with key \"{data.key}\" already exists", 409)

    letter_type = LetterType(
        key=data.key.strip().lower(),
        name=data.name.strip(),
        description=data.description,
        is_active=data.is_active,
        sort_order=data.sort_order,
        created_by=current_user.id,
        updated_by=current_user.id,
    )
    db.add(letter_type)
    db.commit()
    db.refresh(letter_type)
    return letter_type


@router.put("/types/{type_id}")
def update_letter_type(
    type_id: int,
    data: LetterTypeIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_template_admin),
):
    letter_type = db.query(LetterType).filter(LetterType.id == type_id).first()
    if not letter_type:
        raise HTTPException(status_code=404, detail="Letter type not found")

    duplicate = db.query(LetterType).filter(
        LetterType.key == data.key.strip().lower(), LetterType.id != type_id
    ).first()
    if duplicate:
        raise field_error("key", f"A letter type with key \"{data.key}\" already exists", 409)

    letter_type.key = data.key.strip().lower()
    letter_type.name = data.name.strip()
    letter_type.description = data.description
    letter_type.is_active = data.is_active
    letter_type.sort_order = data.sort_order
    letter_type.updated_by = current_user.id

    db.commit()
    db.refresh(letter_type)
    return letter_type


@router.delete("/types/{type_id}")
def delete_letter_type(
    type_id: int,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(require_template_admin),
):
    letter_type = db.query(LetterType).filter(LetterType.id == type_id).first()
    if not letter_type:
        raise HTTPException(status_code=404, detail="Letter type not found")

    db.delete(letter_type)
    db.commit()
    return {"message": f"Letter type \"{letter_type.name}\" deleted successfully"}


# ─── Letter Templates ────────────────────────────────────────────────────────

@router.get("/templates")
def list_letter_templates(
    search: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    db: Session = Depends(get_tenant_db),
    _: User = Depends(require_permission("letter_management.view")),
):
    q = db.query(LetterTemplate).filter(LetterTemplate.is_deleted == False)

    if search:
        like = f"%{search}%"
        q = q.filter(
            (LetterTemplate.name.ilike(like)) | (LetterTemplate.subject.ilike(like))
        )

    templates = q.order_by(LetterTemplate.updated_at.desc(), LetterTemplate.created_at.desc()).all()

    out = [_template_out(db, t) for t in templates]
    if category and category != "All":
        out = [t for t in out if t["category"] == category]
    return out


@router.get("/templates/trash")
def list_trashed_templates(
    db: Session = Depends(get_tenant_db),
    _: User = Depends(require_template_admin),
):
    templates = db.query(LetterTemplate).filter(
        LetterTemplate.is_deleted == True
    ).order_by(LetterTemplate.deleted_at.desc()).all()
    return [_trash_out(db, t) for t in templates]


@router.post("/templates", status_code=201)
def create_letter_template(
    data: LetterTemplateIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_template_admin),
):
    letter_type_id = _get_or_create_letter_type(db, data.category, current_user)

    template = LetterTemplate(
        letter_type_id=letter_type_id,
        name=data.name.strip(),
        folder=(data.folder or "").strip() or None,
        description=(data.description or "").strip() or None,
        subject=data.subject,
        template_body=data.template_body,
        variables=data.variables,
        version=1,
        is_default=data.is_default,
        is_active=data.is_active,
        created_by=current_user.id,
        updated_by=current_user.id,
    )
    db.add(template)
    db.commit()
    db.refresh(template)
    return _template_out(db, template)


@router.put("/templates/{template_id}")
def update_letter_template(
    template_id: int,
    data: LetterTemplateIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_template_admin),
):
    template = _get_active_template(db, template_id)
    letter_type_id = _get_or_create_letter_type(db, data.category, current_user)

    template.letter_type_id = letter_type_id
    template.name = data.name.strip()
    template.folder = (data.folder or "").strip() or None
    template.description = (data.description or "").strip() or None
    template.subject = data.subject
    template.template_body = data.template_body
    template.variables = data.variables
    template.is_default = data.is_default
    template.is_active = data.is_active
    template.version = (template.version or 1) + 1
    template.updated_by = current_user.id

    db.commit()
    db.refresh(template)
    return _template_out(db, template)


@router.post("/templates/{template_id}/duplicate", status_code=201)
def duplicate_letter_template(
    template_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_template_admin),
):
    source = _get_active_template(db, template_id)

    duplicate = LetterTemplate(
        letter_type_id=source.letter_type_id,
        name=f"{source.name} (Copy)",
        folder=source.folder,
        description=source.description,
        subject=source.subject,
        template_body=source.template_body,
        variables=source.variables,
        version=1,
        is_default=False,
        is_active=True,
        created_by=current_user.id,
        updated_by=current_user.id,
    )
    db.add(duplicate)
    db.commit()
    db.refresh(duplicate)
    return _template_out(db, duplicate)


@router.delete("/templates/trash")
def empty_letter_template_trash(
    db: Session = Depends(get_tenant_db),
    _: User = Depends(require_template_admin),
):
    deleted = db.query(LetterTemplate).filter(LetterTemplate.is_deleted == True).delete(synchronize_session=False)
    db.commit()
    return {"message": f"{deleted} trashed template(s) permanently deleted"}


@router.delete("/templates/{template_id}")
def trash_letter_template(
    template_id: int,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_template_admin),
):
    template = _get_active_template(db, template_id)
    before = model_snapshot(template)
    template.is_deleted = True
    template.deleted_at = now_ist()
    template.deleted_by = current_user.id
    db.add(AuditLog(
        user_id=current_user.id,
        module="letter_management",
        action="delete",
        record_id=template.id,
        record_name=template.name,
        old_data=before,
        new_data={"is_deleted": True, "deleted_at": template.deleted_at.isoformat()},
        description=f"Deleted letter template {template.name}",
        ip_address=get_request_ip(request),
        created_at=now_ist(),
    ))
    db.commit()
    return {"message": f"Template \"{template.name}\" moved to trash"}


@router.post("/templates/{template_id}/restore")
def restore_letter_template(
    template_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_template_admin),
):
    template = db.query(LetterTemplate).filter(
        LetterTemplate.id == template_id, LetterTemplate.is_deleted == True
    ).first()
    if not template:
        raise HTTPException(status_code=404, detail="Trashed template not found")

    template.is_deleted = False
    template.deleted_at = None
    template.deleted_by = None
    template.updated_by = current_user.id
    db.commit()
    db.refresh(template)
    return _template_out(db, template)


@router.delete("/templates/{template_id}/permanent")
def permanently_delete_letter_template(
    template_id: int,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(require_template_admin),
):
    template = db.query(LetterTemplate).filter(
        LetterTemplate.id == template_id, LetterTemplate.is_deleted == True
    ).first()
    if not template:
        raise HTTPException(status_code=404, detail="Trashed template not found")

    db.delete(template)
    db.commit()
    return {"message": f"Template \"{template.name}\" permanently deleted"}


# ─── Letters ─────────────────────────────────────────────────────────────────

@router.get("/letters")
def list_letters(
    status: Optional[str] = Query(None),
    letter_type_id: Optional[int] = Query(None),
    search: Optional[str] = Query(None),
    skip: int = 0,
    limit: int = 1000,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(require_permission("letter_management.view")),
):
    q = db.query(Letter).filter(Letter.is_deleted == False)

    if status:
        q = q.filter(Letter.status == status)
    if letter_type_id:
        q = q.filter(Letter.letter_type_id == letter_type_id)
    if search:
        like = f"%{search}%"
        q = q.filter(
            (Letter.title.ilike(like)) | (Letter.letter_no.ilike(like)) | (Letter.recipient_name.ilike(like))
        )

    return q.order_by(Letter.created_at.desc()).offset(skip).limit(limit).all()


# Declared before /letters/{letter_id} so "trash" is not parsed as a letter id.
@router.get("/letters/trash")
def list_trashed_letters(
    db: Session = Depends(get_tenant_db),
    _: User = Depends(require_permission("letter_management.view")),
):
    letters = db.query(Letter).filter(Letter.is_deleted == True).order_by(Letter.deleted_at.desc()).all()
    return [
        {
            "id": letter.id,
            "title": letter.title,
            "recipient_name": letter.recipient_name,
            "deleted_at": letter.deleted_at.isoformat() if letter.deleted_at else None,
            "deleted_by": letter.deleted_by,
        }
        for letter in letters
    ]


@router.post("/letters", status_code=201)
def create_letter(
    data: LetterCreate,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("letter_management.create")),
):
    letter = Letter(
        letter_type_id=data.letter_type_id,
        letter_template_id=data.letter_template_id,
        title=data.title.strip(),
        subject=data.subject,
        body=data.body,
        status="Draft",
        linked_source=data.linked_source,
        linked_record_id=data.linked_record_id,
        linked_record_label=data.linked_record_label,
        recipient_name=data.recipient_name,
        recipient_email=data.recipient_email,
        recipient_address=data.recipient_address,
        issue_date=data.issue_date,
        created_by=current_user.id,
        updated_by=current_user.id,
    )
    db.add(letter)
    db.flush()

    letter.letter_no = f"LTR-{datetime.now().year}-{letter.id:05d}"
    _record_history(db, letter.id, "created", current_user, to_status="Draft")

    db.commit()
    db.refresh(letter)
    return letter


@router.get("/letters/{letter_id}")
def get_letter(
    letter_id: int,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(require_permission("letter_management.view")),
):
    letter = _get_letter(db, letter_id)
    documents = db.query(LetterDocument).filter(LetterDocument.letter_id == letter_id).order_by(
        LetterDocument.created_at.desc()
    ).all()
    history = db.query(LetterHistory).filter(LetterHistory.letter_id == letter_id).order_by(
        LetterHistory.created_at.desc()
    ).all()
    return {"letter": letter, "documents": documents, "history": history}


@router.put("/letters/{letter_id}")
def update_letter(
    letter_id: int,
    data: LetterUpdate,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("letter_management.update")),
):
    letter = _get_letter(db, letter_id)
    if letter.status not in ("Draft",):
        raise HTTPException(status_code=409, detail=f"Letter is {letter.status} and can no longer be edited")

    old_data = {
        "title": letter.title, "subject": letter.subject, "body": letter.body,
        "recipient_name": letter.recipient_name, "recipient_email": letter.recipient_email,
    }

    update_data = data.model_dump(exclude_unset=True, exclude={"status"})
    for field, val in update_data.items():
        setattr(letter, field, val)
    letter.updated_by = current_user.id

    _record_history(
        db, letter.id, "updated", current_user,
        old_data=old_data,
        new_data={k: getattr(letter, k) for k in old_data},
    )

    db.commit()
    db.refresh(letter)
    return letter


@router.post("/letters/{letter_id}/issue")
def issue_letter(
    letter_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("letter_management.update")),
):
    letter = _get_letter(db, letter_id)
    if letter.status == "Issued":
        raise HTTPException(status_code=409, detail="Letter has already been issued")

    from_status = letter.status
    letter.status = "Issued"
    letter.issued_at = now_ist()
    letter.issued_by = current_user.id
    letter.updated_by = current_user.id

    _record_history(db, letter.id, "issued", current_user, from_status=from_status, to_status="Issued")
    _sync_issued_letter_to_quotation(db, letter, current_user)

    db.commit()
    db.refresh(letter)
    return letter


@router.post("/letters/{letter_id}/finalize")
async def finalize_letter(
    letter_id: int,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("letter_management.update")),
):
    """Issues the letter and saves its generated PDF to Document Hub, linked to the letter."""
    letter = _get_letter(db, letter_id)
    existing = db.query(DocumentManagementFile).filter(
        DocumentManagementFile.linked_source == "letters",
        DocumentManagementFile.linked_record_id == letter.id,
        DocumentManagementFile.doc_type == ISSUED_LETTER_DOC_TYPE,
        DocumentManagementFile.deleted_at.is_(None),
    ).first()
    if letter.status == "Issued" and existing:
        return {"letter": letter, "document_id": existing.id, "file_url": existing.file_url, "created": False}

    if os.path.splitext(file.filename or "")[-1].lower() != ".pdf":
        raise HTTPException(status_code=400, detail="The letter file must be a PDF")
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="The letter PDF is empty")

    saved = save_upload_optimized(
        root_dir=os.path.abspath(MEDIA_ROOT),
        subfolder="document-management",
        original_filename=file.filename,
        contents=contents,
        media_slug=media_slug_from_request(request),
        content_type=file.content_type,
    )

    if letter.status != "Issued":
        from_status = letter.status
        letter.status = "Issued"
        letter.issued_at = now_ist()
        letter.issued_by = current_user.id
        letter.updated_by = current_user.id
        _record_history(db, letter.id, "issued", current_user, from_status=from_status, to_status="Issued")

    _sync_issued_letter_to_quotation(db, letter, current_user)

    label = " · ".join(part for part in (letter.title, letter.linked_record_label or letter.recipient_name) if part)
    document = DocumentManagementFile(
        name=(file.filename or f"{letter.letter_no or letter.title}.pdf").strip()[:300],
        description=f"Issued letter {letter.letter_no or ''}".strip()[:500],
        file_url=saved.url,
        file_size_kb=saved.size_kb,
        uploaded_by=current_user.id,
        linked_source="letters",
        linked_record_id=letter.id,
        linked_record_label=label[:300] or None,
        doc_type=ISSUED_LETTER_DOC_TYPE,
    )
    db.add(document)
    db.add(LetterDocument(
        letter_id=letter.id,
        doc_type=ISSUED_LETTER_DOC_TYPE,
        file_name=document.name,
        file_url=saved.url,
        file_size_kb=saved.size_kb,
        mime_type="application/pdf",
        uploaded_by=current_user.id,
    ))
    _record_history(db, letter.id, "document_added", current_user, remarks=document.name)
    db.commit()
    db.refresh(letter)
    db.refresh(document)
    return {"letter": letter, "document_id": document.id, "file_url": document.file_url, "created": True}


@router.delete("/letters/{letter_id}")
def delete_letter(
    letter_id: int,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("letter_management.delete")),
):
    """Moves the letter to the Recycle Bin; it can be restored or permanently deleted from there."""
    letter = _get_letter(db, letter_id)
    if letter.status == "Issued":
        raise HTTPException(status_code=409, detail="An issued letter cannot be deleted")

    before = model_snapshot(letter)
    letter.is_deleted = True
    letter.deleted_at = now_ist()
    letter.deleted_by = current_user.id
    _record_history(db, letter.id, "deleted", current_user)
    db.add(AuditLog(
        user_id=current_user.id,
        module="letter_management",
        action="delete",
        record_id=letter.id,
        record_name=letter.title,
        old_data=before,
        new_data={"is_deleted": True, "deleted_at": letter.deleted_at.isoformat()},
        description=f"Deleted letter {letter.title}",
        ip_address=get_request_ip(request),
        created_at=now_ist(),
    ))
    db.commit()
    return {"message": f"Letter \"{letter.title}\" moved to the Recycle Bin"}


def _get_trashed_letter(db: Session, letter_id: int) -> Letter:
    letter = db.query(Letter).filter(Letter.id == letter_id, Letter.is_deleted == True).first()
    if not letter:
        raise HTTPException(status_code=404, detail="Trashed letter not found")
    return letter


@router.post("/letters/{letter_id}/restore")
def restore_letter(
    letter_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("letter_management.delete")),
):
    letter = _get_trashed_letter(db, letter_id)
    letter.is_deleted = False
    letter.deleted_at = None
    letter.deleted_by = None
    letter.updated_by = current_user.id
    _record_history(db, letter.id, "restored", current_user)
    db.commit()
    db.refresh(letter)
    return letter


@router.delete("/letters/{letter_id}/permanent")
def permanently_delete_letter(
    letter_id: int,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(require_permission("letter_management.delete")),
):
    letter = _get_trashed_letter(db, letter_id)
    db.delete(letter)
    db.commit()
    return {"message": f"Letter \"{letter.title}\" permanently deleted"}


# ─── Letter Documents ────────────────────────────────────────────────────────

@router.get("/letters/{letter_id}/documents")
def list_letter_documents(
    letter_id: int,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(require_permission("letter_management.view")),
):
    _get_letter(db, letter_id)
    return db.query(LetterDocument).filter(LetterDocument.letter_id == letter_id).order_by(
        LetterDocument.created_at.desc()
    ).all()


@router.post("/letters/{letter_id}/documents", status_code=201)
def add_letter_document(
    letter_id: int,
    data: LetterDocumentIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("letter_management.update")),
):
    _get_letter(db, letter_id)

    document = LetterDocument(
        letter_id=letter_id,
        doc_type=data.doc_type,
        file_name=data.file_name,
        file_url=data.file_url,
        file_size_kb=data.file_size_kb,
        mime_type=data.mime_type,
        uploaded_by=current_user.id,
    )
    db.add(document)
    _record_history(db, letter_id, "document_added", current_user, remarks=data.file_name)
    db.commit()
    db.refresh(document)
    return document


@router.delete("/letters/{letter_id}/documents/{document_id}")
def delete_letter_document(
    letter_id: int,
    document_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("letter_management.update")),
):
    document = db.query(LetterDocument).filter(
        LetterDocument.id == document_id, LetterDocument.letter_id == letter_id
    ).first()
    if not document:
        raise HTTPException(status_code=404, detail="Letter document not found")

    db.delete(document)
    _record_history(db, letter_id, "document_removed", current_user, remarks=document.file_name)
    db.commit()
    return {"message": f"Document \"{document.file_name}\" removed"}