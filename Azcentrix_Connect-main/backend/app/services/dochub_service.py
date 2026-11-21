"""Document Hub (prototype v17 R.docs + the current Document Management options).

Standalone uploads (document_management_files) are listed with ONE paginated SELECT (owner, folder, starred / shared-with-me
EXISTS) – the prototype's tags and versions are two new columns on that table (tags JSON, version / version_of).  Documents
that live on CRM records (tenders, work orders, guarantees, RFP, travel) keep coming from the existing collectors when a
source is chosen.  Folders are shared (prototype) or personal (current option); the prototype's default folders are
seeded once per tenant.  Move / trash / restore / star / share / approval keep the existing /document-management endpoints.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Any, Optional

from fastapi import HTTPException, Request, UploadFile
from sqlalchemy import and_, exists, func, or_, text
from sqlalchemy.orm import Session

from app.core.timezone import now_ist
from app.models.all_models import DocumentFolder, DocumentManagementFile, DocumentShare, DocumentStar, User

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

VIEWS = [("all", "All files"), ("mine", "My files"), ("shared", "Shared with me"), ("starred", "Starred"), ("trash", "Trash")]
DEFAULT_FOLDERS = ["Tender Documents", "Technical Bids", "Financial Bids", "Certificates", "Work Orders", "Letters", "OEM Authorisations"]
DDL = [
    "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS tags JSON NULL",
    "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1",
    "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS version_of INT NULL",
    "ALTER TABLE document_folders ADD COLUMN IF NOT EXISTS is_shared TINYINT(1) NOT NULL DEFAULT 0",
    "CREATE INDEX IF NOT EXISTS ix_dmf_folder_deleted ON document_management_files (folder_id, deleted_at)",
    "CREATE INDEX IF NOT EXISTS ix_dmf_owner_deleted ON document_management_files (uploaded_by, deleted_at)",
    "CREATE INDEX IF NOT EXISTS ix_dmf_version_of ON document_management_files (version_of)",
    "CREATE INDEX IF NOT EXISTS ix_dmf_created ON document_management_files (deleted_at, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_document_folders_shared ON document_folders (is_shared, name)",
]


def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        for ddl in DDL:
            try:
                db.execute(text(ddl))
            except Exception as exc:
                logger.debug("dochub ddl skipped: %s (%s)", ddl[:60], exc)
                db.rollback()
        db.commit()
        if not db.execute(text("SELECT 1 FROM document_folders WHERE is_shared = 1 LIMIT 1")).first():
            owner = db.query(User.id).filter(User.role.in_(("admin", "ceo")), User.is_active.is_(True)).order_by(User.id).first() or db.query(User.id).order_by(User.id).first()
            if owner:
                for n in DEFAULT_FOLDERS:
                    db.execute(text("INSERT INTO document_folders (name, parent_id, owner_id, is_shared, created_at) VALUES (:n, NULL, :o, 1, :t)"), {"n": n, "o": owner[0], "t": now_ist()})
                db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant.slug).all()]
    except Exception as exc:  # pragma: no cover
        logger.warning("Document hub schema sync: unable to list tenants: %s", exc)
        return
    finally:
        master.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_schema(db)
            finally:
                db.close()
        except Exception as exc:
            logger.warning("Document hub schema sync failed for %s: %s", slug, exc)


# ─── helpers ──────────────────────────────────────────────────────────────────

def _like(s: str) -> str:
    return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _d(v) -> Optional[str]:
    return v.isoformat() if v else None


def _doc_id(rec: DocumentManagementFile) -> str:
    from app.routers.document_management_router import _standalone_document_id
    return _standalone_document_id(rec)


def _ext(name: str, url: str) -> str:
    base = name or url or ""
    return (os.path.splitext(base)[1] or "").lstrip(".").upper() or "FILE"


def _tags(v) -> list[str]:
    return [str(t) for t in v] if isinstance(v, list) else []


def _is_admin(cu: User) -> bool:
    return (cu.role or "") in ("admin", "ceo")


# ─── meta ─────────────────────────────────────────────────────────────────────

def meta(db: Session, cu: User, can_create: bool) -> dict:
    from app.routers.document_management_router import DOCUMENT_SOURCE_LABELS
    F = DocumentManagementFile
    live = F.deleted_at.is_(None)
    counts = dict(db.query(F.folder_id, func.count(F.id)).filter(live, F.folder_id.isnot(None)).group_by(F.folder_id).all())
    folders = db.query(DocumentFolder).filter(or_(DocumentFolder.owner_id == cu.id, text("document_folders.is_shared = 1"))).order_by(text("document_folders.is_shared DESC"), DocumentFolder.name).all()
    shared_flag = dict(db.execute(text("SELECT id, is_shared FROM document_folders")).all())
    my_ids = db.query(DocumentStar.document_id).filter(DocumentStar.user_id == cu.id).subquery()
    sh_ids = db.query(DocumentShare.document_id).filter(DocumentShare.shared_with == cu.id).subquery()
    total = db.query(func.count(F.id)).filter(live).scalar() or 0
    mine = db.query(func.count(F.id)).filter(live, F.uploaded_by == cu.id).scalar() or 0
    trash = db.query(func.count(F.id)).filter(F.deleted_at.isnot(None), *([] if _is_admin(cu) else [F.uploaded_by == cu.id])).scalar() or 0
    starred = db.query(func.count()).select_from(my_ids).scalar() or 0
    shared = db.query(func.count()).select_from(sh_ids).scalar() or 0
    return {"views": [{"k": k, "l": l, "n": {"all": total, "mine": mine, "shared": shared, "starred": starred, "trash": trash}[k]} for k, l in VIEWS],
            "folders": [{"id": f.id, "name": f.name, "shared": bool(shared_flag.get(f.id)), "n": int(counts.get(f.id, 0)), "mine": f.owner_id == cu.id} for f in folders],
            "sources": [{"k": k, "l": l} for k, l in DOCUMENT_SOURCE_LABELS.items() if k != "standalone"], "can_create": can_create,
            "storage_kb": int(db.query(func.coalesce(func.sum(F.file_size_kb), 0)).filter(live).scalar() or 0)}


# ─── list ─────────────────────────────────────────────────────────────────────

def _row(r: DocumentManagementFile, owner: Optional[str], folder: Optional[str], starred: bool, shared: bool, cu: User, can_approve: bool) -> dict:
    return {"id": _doc_id(r), "rid": r.id, "name": r.name, "ext": _ext(r.name, r.file_url), "folder": folder or "", "folder_id": r.folder_id, "tags": _tags(r.tags),
            "link": r.linked_record_label or "", "link_source": r.linked_source or "", "link_id": r.linked_record_id, "size_kb": int(r.file_size_kb or 0), "ver": int(r.version or 1),
            "version_of": r.version_of, "owner": owner or "—", "owner_id": r.uploaded_by, "updated": _d(r.created_at), "status": r.approval_status or "Uploaded", "url": r.file_url,
            "is_starred": starred, "is_shared": shared, "is_mine": r.uploaded_by == cu.id, "deleted_at": _d(r.deleted_at), "source": "standalone",
            "can_submit": r.approval_status in (None, "", "Rejected") and (r.uploaded_by == cu.id or _is_admin(cu)), "can_approve": can_approve and r.approval_status == "Pending Approval",
            "can_trash": r.deleted_at is None and (r.uploaded_by == cu.id or _is_admin(cu)), "doc_type": r.doc_type or ""}


def list_docs(db: Session, cu: User, *, view: str, folder_id: Optional[int], source: str, q: str, tag: str, offset: int, limit: int, can_approve: bool) -> dict:
    F = DocumentManagementFile
    if source and source != "standalone":
        return _linked(db, cu, source, q, offset, limit)
    star = exists().where(and_(DocumentStar.document_id == func.concat("standalone:", func.coalesce(F.linked_record_id, 0), ":", F.id, ":", func.coalesce(F.doc_type, "Uploaded Document")),
                                DocumentStar.user_id == cu.id))
    base = db.query(F, User.full_name, DocumentFolder.name).outerjoin(User, User.id == F.uploaded_by).outerjoin(DocumentFolder, DocumentFolder.id == F.folder_id)
    if view == "trash":
        base = base.filter(F.deleted_at.isnot(None))
        if not _is_admin(cu):
            base = base.filter(F.uploaded_by == cu.id)
    else:
        base = base.filter(F.deleted_at.is_(None), F.version_of.is_(None) | (F.id == F.id))   # every row is a version; latest shown first
    if view == "mine":
        base = base.filter(F.uploaded_by == cu.id)
    if folder_id:
        base = base.filter(F.folder_id == folder_id)
    if q:
        base = base.filter(or_(F.name.ilike(_like(q)), F.linked_record_label.ilike(_like(q)), F.doc_type.ilike(_like(q)), func.cast(F.tags, text("CHAR")).ilike(_like(q))))
    if tag:
        base = base.filter(func.json_contains(F.tags, func.json_quote(tag)))
    rows = base.order_by(F.created_at.desc(), F.id.desc())
    # star / share need the composite document id; resolved after paging with two IN queries (bounded by the page)
    if view in ("starred", "shared"):
        ids_sq = (db.query(DocumentStar.document_id).filter(DocumentStar.user_id == cu.id) if view == "starred" else
                  db.query(DocumentShare.document_id).filter(DocumentShare.shared_with == cu.id)).all()
        wanted = {str(i[0]) for i in ids_sq}
        rids = [int(x.split(":")[2]) for x in wanted if x.startswith("standalone:") and x.count(":") >= 3 and x.split(":")[2].isdigit()]
        rows = rows.filter(F.id.in_(rids or [0]))
    total = rows.with_entities(func.count(F.id)).order_by(None).scalar() or 0
    page = rows.offset(offset).limit(limit).all()
    ids = [_doc_id(r) for r, _, _ in page]
    starred = {s for (s,) in db.query(DocumentStar.document_id).filter(DocumentStar.user_id == cu.id, DocumentStar.document_id.in_(ids or ["-"])).all()}
    shared = {s for (s,) in db.query(DocumentShare.document_id).filter(DocumentShare.shared_with == cu.id, DocumentShare.document_id.in_(ids or ["-"])).all()}
    items = [_row(r, o, f, _doc_id(r) in starred, _doc_id(r) in shared, cu, can_approve) for r, o, f in page]
    return {"items": items, "total": int(total)}


def _linked(db: Session, cu: User, source: str, q: str, offset: int, limit: int) -> dict:
    from app.routers.document_management_router import DOCUMENT_SOURCE_LABELS, _collect_documents, _prepare_document_payload
    if source not in DOCUMENT_SOURCE_LABELS:
        raise HTTPException(422, "Unknown source")
    docs, _ = _collect_documents(db, cu, source_filter=source, limit=500)
    if q:
        ql = q.lower()
        docs = [d for d in docs if ql in (d.get("name") or "").lower() or ql in (d.get("record_label") or "").lower()]
    cleaned, _ = _prepare_document_payload(db, cu, docs, 500)
    cleaned.sort(key=lambda d: d.get("updated_at") or "", reverse=True)
    page = cleaned[offset: offset + limit]
    items = [{"id": d["id"], "rid": None, "name": d["name"], "ext": d.get("file_type") or "FILE", "folder": DOCUMENT_SOURCE_LABELS.get(source, source), "folder_id": None,
              "tags": [], "link": d.get("record_label") or "", "link_source": source, "link_id": d.get("record_id"), "size_kb": int(d.get("size_kb") or 0), "ver": 1,
              "version_of": None, "owner": d.get("owner") or "—", "owner_id": d.get("owner_id"), "updated": d.get("updated_at"), "status": d.get("status") or "",
              "url": d.get("url"), "is_starred": bool(d.get("is_starred")), "is_shared": bool(d.get("is_shared_with_me")), "is_mine": bool(d.get("is_mine")),
              "deleted_at": d.get("deleted_at"), "source": source, "can_submit": False, "can_approve": False, "can_trash": bool(d.get("can_trash")), "doc_type": d.get("doc_type") or ""}
             for d in page]
    return {"items": items, "total": len(cleaned)}


# ─── upload / versions / tags ─────────────────────────────────────────────────

async def upload(db: Session, cu: User, request: Request, file: UploadFile, *, folder_id: Optional[int], tags: list[str], linked_source: Optional[str],
                 linked_record_id: Optional[int], version_of: Optional[int], doc_type: Optional[str], description: Optional[str]) -> dict:
    from app.routers.document_management_router import ALLOWED_UPLOAD_EXTENSIONS, MEDIA_ROOT, _resolve_linked_record
    from app.utils.file_storage import media_slug_from_request, save_upload_optimized
    ext = os.path.splitext(file.filename or "")[-1].lower()
    if ext not in ALLOWED_UPLOAD_EXTENSIONS:
        raise HTTPException(400, f"File type '{ext or 'unknown'}' is not allowed")
    contents = await file.read()
    if not contents:
        raise HTTPException(400, "The file is empty")
    if len(contents) > 50 * 1024 * 1024:
        raise HTTPException(413, "Files larger than 50 MB are not accepted")
    parent = None
    if version_of:
        parent = db.query(DocumentManagementFile).filter(DocumentManagementFile.id == version_of, DocumentManagementFile.deleted_at.is_(None)).first()
        if parent is None:
            raise HTTPException(404, "The document to version is not available")
        if parent.uploaded_by != cu.id and not _is_admin(cu):
            raise HTTPException(403, "Only the owner can add a version")
    if folder_id is not None:
        f = db.query(DocumentFolder).filter(DocumentFolder.id == folder_id).first()
        if f is None:
            raise HTTPException(404, "Folder not found")
    linked = _resolve_linked_record(db, cu, linked_source, linked_record_id) if linked_source else None
    saved = save_upload_optimized(root_dir=os.path.abspath(MEDIA_ROOT), subfolder="document-management", original_filename=file.filename, contents=contents,
                                  media_slug=media_slug_from_request(request), content_type=file.content_type, force_compression=True)
    root_id = (parent.version_of or parent.id) if parent else None
    ver = 1
    if parent:
        ver = (db.query(func.max(DocumentManagementFile.version)).filter(or_(DocumentManagementFile.id == root_id, DocumentManagementFile.version_of == root_id)).scalar() or 1) + 1
    rec = DocumentManagementFile(name=(parent.name if parent else (file.filename or "Document")).strip()[:300], description=(description or (parent.description if parent else "") or "")[:500] or None,
                                 file_url=saved.url, file_size_kb=saved.size_kb, uploaded_by=cu.id, linked_source=(linked["source_key"] if linked else (parent.linked_source if parent else None)),
                                 linked_record_id=(linked["id"] if linked else (parent.linked_record_id if parent else None)),
                                 linked_record_label=(linked["label"] if linked else (parent.linked_record_label if parent else None)),
                                 doc_type=(doc_type or (parent.doc_type if parent else None) or "Uploaded Document")[:120], folder_id=folder_id if folder_id is not None else (parent.folder_id if parent else None),
                                 tags=[t.strip()[:40] for t in tags if t.strip()][:20] or (parent.tags if parent else None), version=ver, version_of=root_id)
    db.add(rec)
    db.commit()
    return {"id": rec.id, "document_id": _doc_id(rec), "version": ver}


def versions(db: Session, rid: int) -> list[dict]:
    F = DocumentManagementFile
    r = db.get(F, rid)
    if r is None:
        raise HTTPException(404, "Document not found")
    root = r.version_of or r.id
    rows = db.query(F, User.full_name).outerjoin(User, User.id == F.uploaded_by).filter(or_(F.id == root, F.version_of == root)).order_by(F.version.desc(), F.id.desc()).all()
    latest = rows[0][0].id if rows else None
    return [{"rid": x.id, "ver": int(x.version or 1), "by": n or "—", "d": _d(x.created_at), "url": x.file_url, "size_kb": int(x.file_size_kb or 0), "current": x.id == latest,
             "deleted": x.deleted_at is not None} for x, n in rows]


def set_tags(db: Session, cu: User, rid: int, tags: list[str]) -> list[str]:
    r = db.query(DocumentManagementFile).filter(DocumentManagementFile.id == rid, DocumentManagementFile.deleted_at.is_(None)).first()
    if r is None:
        raise HTTPException(404, "Document not found")
    if r.uploaded_by != cu.id and not _is_admin(cu):
        raise HTTPException(403, "Only the owner can tag this document")
    clean: list[str] = []
    for t in tags:
        t = str(t or "").strip()[:40]
        if t and t.lower() not in [c.lower() for c in clean]:
            clean.append(t)
    r.tags = clean[:20]
    db.commit()
    return r.tags or []


# ─── folders ──────────────────────────────────────────────────────────────────

def create_folder(db: Session, cu: User, name: str, shared: bool) -> dict:
    name = (name or "").strip()[:200]
    if not name:
        raise HTTPException(422, "Name the folder")
    if shared and not _is_admin(cu):
        raise HTTPException(403, "Only administrators can create shared folders")
    dup = db.query(DocumentFolder.id).filter(func.lower(DocumentFolder.name) == name.lower(), or_(DocumentFolder.owner_id == cu.id, text("document_folders.is_shared = 1"))).first()
    if dup:
        raise HTTPException(409, "A folder with this name already exists")
    f = DocumentFolder(name=name, owner_id=cu.id)
    db.add(f)
    db.flush()
    db.execute(text("UPDATE document_folders SET is_shared = :s WHERE id = :i"), {"s": 1 if shared else 0, "i": f.id})
    db.commit()
    return {"id": f.id, "name": f.name, "shared": shared}


def rename_folder(db: Session, cu: User, fid: int, name: str) -> None:
    f = db.get(DocumentFolder, fid)
    if f is None:
        raise HTTPException(404, "Folder not found")
    if f.owner_id != cu.id and not _is_admin(cu):
        raise HTTPException(403, "Only the owner can rename this folder")
    name = (name or "").strip()[:200]
    if not name:
        raise HTTPException(422, "Name the folder")
    f.name = name
    db.commit()


def delete_folder(db: Session, cu: User, fid: int) -> None:
    f = db.get(DocumentFolder, fid)
    if f is None:
        raise HTTPException(404, "Folder not found")
    if f.owner_id != cu.id and not _is_admin(cu):
        raise HTTPException(403, "Only the owner can delete this folder")
    n = db.query(func.count(DocumentManagementFile.id)).filter(DocumentManagementFile.folder_id == fid, DocumentManagementFile.deleted_at.is_(None)).scalar() or 0
    if n:
        raise HTTPException(409, f"Move or remove the {n} file(s) in this folder first")
    db.delete(f)
    db.commit()
