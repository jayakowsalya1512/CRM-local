from __future__ import annotations

import os
from datetime import date, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import String, case, cast, func, literal, or_, select, union_all
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, aliased

from app.core.timezone import IST, now_ist
from app.dependencies import get_request_ip, get_tenant_db, require_permission
from app.models.all_models import (
    AuditLog,
    Customer,
    DocumentManagementFile,
    DocumentShare,
    DocumentStar,
    DocumentTrash,
    Lead,
    Letter,
    LetterTemplate,
    OEM,
    Tender,
    User,
)
from app.utils.file_storage import delete_stored_file, media_url_to_logical_path

router = APIRouter(tags=["Recycle Bin"])

MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "media")


def _iso(value: Any) -> str | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=IST).isoformat() if value.tzinfo is None else value.isoformat()
    return str(value)


def _clean_module(value: str) -> str:
    module_key = str(value or "").strip().lower()
    if module_key not in RECYCLE_HANDLERS:
        raise HTTPException(status_code=404, detail="Recycle bin source not found")
    return module_key


def _clean_search(value: str | None) -> str:
    return str(value or "").strip()


def _row(
    *,
    module_key: str,
    module_label: str,
    record_id: str,
    title: str,
    subtitle: str | None = None,
    deleted_at: Any = None,
    deleted_by: int | None = None,
    created_at: Any = None,
    updated_at: Any = None,
) -> dict[str, Any]:
    return {
        "id": f"{module_key}:{record_id}",
        "module_key": module_key,
        "module_label": module_label,
        "record_id": str(record_id),
        "title": title or f"{module_label} #{record_id}",
        "subtitle": subtitle,
        "deleted_at": _iso(deleted_at),
        "deleted_by": deleted_by,
        "created_at": _iso(created_at),
        "updated_at": _iso(updated_at),
    }


def _restore_is_deleted(db: Session, model: Any, record_id: str) -> str:
    item = db.query(model).filter(model.id == int(record_id), model.is_deleted == True).with_for_update().first()
    if not item:
        raise HTTPException(status_code=404, detail="Trashed record not found")
    item.is_deleted = False
    db.flush()
    return str(item.id)


def _delete_is_deleted(db: Session, model: Any, record_id: str) -> str:
    item = db.query(model).filter(model.id == int(record_id), model.is_deleted == True).with_for_update().first()
    if not item:
        raise HTTPException(status_code=404, detail="Trashed record not found")
    db.delete(item)
    db.flush()
    return str(record_id)


def _letter_record(record_id: str) -> tuple[Any, int]:
    """Letter Management holds both templates ("template:<id>") and letters ("letter:<id>").
    A bare id is a template, as recorded before letters were added."""
    kind, _, raw_id = record_id.rpartition(":")
    model = {"": LetterTemplate, "template": LetterTemplate, "letter": Letter}.get(kind)
    if model is None or not raw_id.isdigit():
        raise HTTPException(status_code=400, detail="Invalid record id")
    return model, int(raw_id)


def _restore_letter(db: Session, record_id: str) -> str:
    model, item_id = _letter_record(record_id)
    item = db.query(model).filter(model.id == item_id, model.is_deleted == True).with_for_update().first()
    if not item:
        raise HTTPException(status_code=404, detail="Trashed record not found")
    item.is_deleted = False
    item.deleted_at = None
    item.deleted_by = None
    db.flush()
    return record_id


def _delete_letter(db: Session, record_id: str) -> str:
    model, item_id = _letter_record(record_id)
    item = db.query(model).filter(model.id == item_id, model.is_deleted == True).with_for_update().first()
    if not item:
        raise HTTPException(status_code=404, detail="Trashed record not found")
    db.delete(item)
    db.flush()
    return record_id


def _restore_document(db: Session, record_id: str, current_user: User) -> str:
    marker = db.query(DocumentTrash).filter(DocumentTrash.document_id == record_id).with_for_update().first()
    if marker and marker.deleted_at is not None:
        raise HTTPException(404, "Trashed document not found")
    if marker:
        db.delete(marker)

    record = None
    parts = record_id.split(":")
    if len(parts) >= 3 and parts[0] == "standalone":
        try:
            record = db.query(DocumentManagementFile).filter(DocumentManagementFile.id == int(parts[2])).with_for_update().first()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid document id") from exc

    if record is not None and record.deleted_at is None:
        raise HTTPException(404, "Trashed document not found")
    if record is not None:
        record.deleted_at = None
        record.deleted_by = None
    elif marker is None:
        raise HTTPException(status_code=404, detail="Trashed document not found")

    db.flush()
    return record_id


def _delete_document(db: Session, record_id: str, current_user: User) -> str:
    marker = db.query(DocumentTrash).filter(DocumentTrash.document_id == record_id).with_for_update().first()
    record = None
    parts = record_id.split(":")
    if len(parts) >= 3 and parts[0] == "standalone":
        try:
            record = db.query(DocumentManagementFile).filter(DocumentManagementFile.id == int(parts[2])).with_for_update().first()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid document id") from exc

    if (marker is not None and marker.deleted_at is not None) or (record is not None and record.deleted_at is None) or (marker is None and record is None):
        raise HTTPException(status_code=404, detail="Trashed document not found")

    db.query(DocumentShare).filter(DocumentShare.document_id == record_id).delete(synchronize_session=False)
    db.query(DocumentStar).filter(DocumentStar.document_id == record_id).delete(synchronize_session=False)

    file_url = record.file_url if record is not None else None
    if record is not None:
        db.delete(record)
        if marker is not None:
            db.delete(marker)
    elif marker is not None:
        marker.deleted_at = now_ist()
        marker.deleted_by = current_user.id

    db.flush()

    if file_url:
        db.info.setdefault("recycle_files", []).append(file_url)
    return record_id


RECYCLE_HANDLERS = {
    "customers": {
        "label": "Customers",
        "restore": lambda db, record_id, current_user: _restore_is_deleted(db, Customer, record_id),
        "delete": lambda db, record_id, current_user: _delete_is_deleted(db, Customer, record_id),
    },
    "leads": {
        "label": "Leads",
        "restore": lambda db, record_id, current_user: _restore_is_deleted(db, Lead, record_id),
        "delete": lambda db, record_id, current_user: _delete_is_deleted(db, Lead, record_id),
    },
    "opportunities": {
        "label": "Opportunities",
        "restore": lambda db, record_id, current_user: _restore_is_deleted(db, Lead, record_id),
        "delete": lambda db, record_id, current_user: _delete_is_deleted(db, Lead, record_id),
    },
    "tenders": {
        "label": "Tenders",
        "restore": lambda db, record_id, current_user: _restore_is_deleted(db, Tender, record_id),
        "delete": lambda db, record_id, current_user: _delete_is_deleted(db, Tender, record_id),
    },
    "oems": {
        "label": "OEMs",
        "restore": lambda db, record_id, current_user: _restore_is_deleted(db, OEM, record_id),
        "delete": lambda db, record_id, current_user: _delete_is_deleted(db, OEM, record_id),
    },
    "document_management": {
        "label": "Documents",
        "restore": _restore_document,
        "delete": _delete_document,
    },
    "letter_management": {
        "label": "Letter Management",
        "restore": lambda db, record_id, current_user: _restore_letter(db, record_id),
        "delete": lambda db, record_id, current_user: _delete_letter(db, record_id),
    },
}


def _deleted_source(db: Session):
    # Select the latest actual deletion event; never infer deletion from edits.
    latest = select(AuditLog.module, AuditLog.record_id, func.max(AuditLog.id).label("audit_id")).where(
        func.lower(func.trim(AuditLog.action)).in_(["delete", "deleted"])
    ).group_by(AuditLog.module, AuditLog.record_id).subquery()
    queries = []
    for key, model, title, subtitle in [
        ("customers", Customer, Customer.customer_name, Customer.customer_vertical),
        ("leads", Lead, Lead.lead_title, Lead.customer_name),
        ("opportunities", Lead, Lead.lead_title, Lead.customer_name),
        ("tenders", Tender, Tender.tender_title, Tender.customer_name),
        ("oems", OEM, OEM.name, OEM.contact_email),
    ]:
        audit_module = "leads" if key == "opportunities" else key
        updated_col = (model.updated_at if hasattr(model, "updated_at") else literal(None)).label("updated_at")
        q = select(literal(key).label("module_key"), cast(model.id, String).label("record_id"),
                   title.label("title"), subtitle.label("subtitle"), AuditLog.created_at.label("deleted_at"),
                   AuditLog.user_id.label("deleted_by"), model.created_at.label("created_at"), updated_col
                   ).select_from(model).outerjoin(
            latest, (latest.c.module == audit_module) & (latest.c.record_id == model.id)
        ).outerjoin(AuditLog, AuditLog.id == latest.c.audit_id).where(model.is_deleted == True)
        if key == "leads":
            q = q.where(or_(Lead.lead_type != "direct_opportunity", Lead.lead_type.is_(None)))
        elif key == "opportunities":
            q = q.where(Lead.lead_type == "direct_opportunity")
        queries.append(q)
    queries.append(select(literal("letter_management"), literal("template:") + cast(LetterTemplate.id, String),
        LetterTemplate.name, LetterTemplate.subject,
        LetterTemplate.deleted_at, LetterTemplate.deleted_by, LetterTemplate.created_at, LetterTemplate.updated_at
    ).where(LetterTemplate.is_deleted == True))
    # A letter is named after its template; its own title (description) and recipient go in the subtitle.
    letter_template = aliased(LetterTemplate)
    queries.append(select(literal("letter_management"), literal("letter:") + cast(Letter.id, String),
        func.coalesce(letter_template.name, Letter.title),
        func.concat_ws(" · ", func.nullif(Letter.title, letter_template.name), Letter.recipient_name),
        Letter.deleted_at, Letter.deleted_by, Letter.created_at, Letter.updated_at
    ).select_from(Letter).outerjoin(letter_template, letter_template.id == Letter.letter_template_id
    ).where(Letter.is_deleted == True))
    document_id = literal("standalone:") + cast(case((func.coalesce(DocumentManagementFile.linked_source, "standalone") == "standalone", 0), else_=func.coalesce(DocumentManagementFile.linked_record_id, 0)), String) + literal(":") + cast(DocumentManagementFile.id, String) + literal(":") + func.lower(func.replace(func.coalesce(DocumentManagementFile.doc_type, "Uploaded Document"), " ", "_"))
    queries.append(select(literal("document_management"), document_id, DocumentManagementFile.name,
        DocumentManagementFile.description, DocumentManagementFile.deleted_at, DocumentManagementFile.deleted_by,
        DocumentManagementFile.created_at, literal(None)).where(DocumentManagementFile.deleted_at.isnot(None)))
    queries.append(select(literal("document_management"), DocumentTrash.document_id, DocumentTrash.document_id,
        literal("Linked document"), DocumentTrash.trashed_at, DocumentTrash.trashed_by, literal(None), literal(None)
    ).where(DocumentTrash.deleted_at.is_(None), ~DocumentTrash.document_id.like("standalone:%")))
    return union_all(*queries).subquery()


@router.get("")
def list_recycle_bin(
    module: str | None = Query(None), search: str | None = Query(None),
    view: Literal["deleted", "restored"] = Query("deleted"),
    page: int = Query(1, ge=1), limit: int = Query(25, ge=1, le=100),
    deleted_by: int | None = Query(None), date_from: date | None = Query(None), date_to: date | None = Query(None),
    db: Session = Depends(get_tenant_db), _: User = Depends(require_permission("recycle_bin.view")),
):
    if module:
        _clean_module(module)
    if date_from and date_to and date_from > date_to:
        raise HTTPException(422, "Start date must be before end date")
    deleted = _deleted_source(db)
    restored = select(AuditLog.module.label("module_key"), cast(AuditLog.id, String).label("record_id"),
        AuditLog.description.label("title"), cast(AuditLog.record_id, String).label("subtitle"),
        AuditLog.created_at.label("deleted_at"), AuditLog.user_id.label("deleted_by"),
        literal(None).label("created_at"), literal(None).label("updated_at")).where(AuditLog.module.in_(RECYCLE_HANDLERS),
        func.lower(func.trim(AuditLog.action)) == "restore").subquery()

    def filtered(source):
        q = db.query(source)
        term = _clean_search(search)
        if term:
            pattern = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            q = q.filter(or_(*(column.ilike(pattern, escape="\\") for column in [source.c.title, source.c.subtitle, source.c.record_id])))
        if deleted_by is not None:
            q = q.filter(source.c.deleted_by == deleted_by)
        if date_from:
            q = q.filter(source.c.deleted_at >= datetime.combine(date_from, datetime.min.time()))
        if date_to:
            q = q.filter(source.c.deleted_at < datetime.combine(date_to + timedelta(days=1), datetime.min.time()))
        return q

    def counts(source):
        q = filtered(source).subquery()
        result = {key: 0 for key in RECYCLE_HANDLERS}
        result.update(dict(db.query(q.c.module_key, func.count()).group_by(q.c.module_key).all()))
        return result

    deleted_counts, restored_counts = counts(deleted), counts(restored)
    source = deleted if view == "deleted" else restored
    q = filtered(source)
    if module:
        q = q.filter(source.c.module_key == module)
    total = q.count()
    page = min(page, max(1, (total + limit - 1) // limit))
    rows = q.order_by(source.c.deleted_at.is_(None), source.c.deleted_at.desc(), source.c.module_key, source.c.record_id).offset((page - 1) * limit).limit(limit).all()
    actors = db.query(User.id, User.full_name, User.username).all()
    names = {uid: name or username or f"User #{uid}" for uid, name, username in actors}
    items = []
    for row in rows:
        module_label = RECYCLE_HANDLERS[row.module_key]["label"]
        if row.module_key == "letter_management":
            # Deleted rows carry "letter:<id>"; restored rows are audit entries whose description ends "(letter:<id>)".
            is_letter = str(row.record_id).startswith("letter:") if view == "deleted" else "(letter:" in str(row.title or "")
            module_label = "Letter" if is_letter else "Template"
        item = _row(module_key=row.module_key, module_label=module_label,
            record_id=row.record_id, title=row.title, subtitle=row.subtitle, deleted_at=row.deleted_at,
            deleted_by=row.deleted_by, created_at=row.created_at, updated_at=row.updated_at)
        if row.subtitle == "Linked document":
            item["title"] = row.record_id.rsplit(":", 1)[-1].replace("_", " ").title()
        item.update(deleted_by_name=names.get(row.deleted_by), expires_at=None, retention_days=None)
        items.append(item)
    return {"items": items, "total": total, "page": page, "limit": limit,
        "counts": deleted_counts, "restored_counts": restored_counts, "restored_count": sum(restored_counts.values()),
        "restored_items": [], "retention_policy": "Records remain until manually deleted. No automatic expiry.",
        "actors": [{"id": uid, "name": name} for uid, name in sorted(names.items(), key=lambda pair: pair[1].lower())],
        "modules": [{"key": key, "label": value["label"]} for key, value in RECYCLE_HANDLERS.items()]}


class BulkItem(BaseModel):
    module_key: str
    record_id: str = Field(min_length=1, max_length=500)


class BulkRequest(BaseModel):
    items: list[BulkItem] = Field(min_length=1, max_length=100)


def _mutate(db, module_key, record_id, action, current_user, request):
    key = _clean_module(module_key)
    if key == "letter_management":
        model, item_id = _letter_record(record_id)
        # Older links carry a bare template id; the listing now uses the prefixed form.
        record_id = f"{'letter' if model is Letter else 'template'}:{item_id}"
    elif key != "document_management":
        try:
            int(record_id)
        except ValueError:
            raise HTTPException(400, "Invalid record id")
    # Validate the exact source and trash state, including lead/opportunity separation.
    source = _deleted_source(db)
    row = db.query(source).filter(source.c.module_key == key, source.c.record_id == record_id).first()
    if not row:
        raise HTTPException(404, "Trashed record not found")
    RECYCLE_HANDLERS[key][action](db, record_id, current_user)
    db.add(AuditLog(user_id=current_user.id, module=key, action="restore" if action == "restore" else "permanent_delete",
        record_id=int(record_id) if record_id.isdigit() else (_letter_record(record_id)[1] if key == "letter_management" else None), record_name=row.title, ip_address=get_request_ip(request),
        description=f"{'Restored' if action == 'restore' else 'Permanently deleted'} {row.title} ({record_id})",
        old_data={"record_id": record_id, "title": row.title, "deleted_at": _iso(row.deleted_at), "deleted_by": row.deleted_by},
        new_data={"is_deleted": action != "restore"}, created_at=now_ist()))
    db.commit()
    for file_url in db.info.pop("recycle_files", []):
        try:
            delete_stored_file(media_url_to_logical_path(root_dir=os.path.abspath(MEDIA_ROOT), file_url=file_url))
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Recycle bin file cleanup failed")
    return {"module_key": key, "record_id": record_id, "success": True}


def _bulk(payload, action, db, current_user, request):
    results = []
    for item in dict.fromkeys((item.module_key, item.record_id) for item in payload.items):
        try:
            results.append(_mutate(db, *item, action, current_user, request))
        except (HTTPException, IntegrityError) as exc:
            db.rollback()
            db.info.pop("recycle_files", None)
            results.append({"module_key": item[0], "record_id": item[1], "success": False,
                "error": exc.detail if isinstance(exc, HTTPException) else "Related records prevent this operation"})
    deleted = [row for row in results if row["success"]] if action == "delete" else []
    if deleted:
        db.add(AuditLog(
            user_id=current_user.id, module="recycle_bin", action="bulk_delete",
            record_name=f"{len(deleted)} records", ip_address=get_request_ip(request),
            description=f"Permanently deleted {len(deleted)} records from recycle bin",
            new_data={"deleted": deleted, "failed_count": len(results) - len(deleted)},
            created_at=now_ist(),
        ))
        db.commit()
    return {"results": results}


@router.post("/bulk/restore")
def bulk_restore(payload: BulkRequest, request: Request, db: Session = Depends(get_tenant_db),
                 current_user: User = Depends(require_permission("recycle_bin.restore"))):
    return _bulk(payload, "restore", db, current_user, request)


@router.post("/bulk/delete")
def bulk_delete(payload: BulkRequest, request: Request, db: Session = Depends(get_tenant_db),
                current_user: User = Depends(require_permission("recycle_bin.delete"))):
    return _bulk(payload, "delete", db, current_user, request)


@router.post("/{module_key}/{record_id:path}/restore")
def restore_recycle_bin_item(module_key: str, record_id: str, request: Request,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(require_permission("recycle_bin.restore"))):
    return _mutate(db, module_key, record_id, "restore", current_user, request)


@router.delete("/{module_key}/{record_id:path}")
def permanently_delete_recycle_bin_item(module_key: str, record_id: str, request: Request,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(require_permission("recycle_bin.delete"))):
    return _mutate(db, module_key, record_id, "delete", current_user, request)
