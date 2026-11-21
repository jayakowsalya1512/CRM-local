"""Document Hub (prototype v17 R.docs + current options).  Mounted at /api/v1/dochub

GET  /meta                      views (with counts), folders (shared + mine, with counts), linked sources, storage used
POST /query                     {view, folder_id, source, q, tag, offset, limit} → paginated rows
POST /upload                    multipart: file, folder_id, tags, linked_source, linked_record_id, version_of, doc_type, description
GET  /{rid}/versions · PUT /{rid}/tags
POST /folders · PUT /folders/{id} · DELETE /folders/{id}

Move, trash, restore, star, share, submit-approval, approve, reject and delete stay on /api/v1/document-management.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.logging import log_module_action
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.services import dochub_service as S

router = APIRouter(tags=["Document Hub"])
ADMIN = ("admin", "ceo")


def _perm(db: Session, cu: User, key: str) -> bool:
    return (cu.role or "") in ADMIN or user_has_permission(db, cu, f"document_management.{key}")


def viewer(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not _perm(db, cu, "view"):
        raise HTTPException(403, "You don't have access to the Document Hub")
    S.ensure_schema(db)
    return cu


def creator(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not _perm(db, cu, "create"):
        raise HTTPException(403, "You don't have permission to upload documents")
    S.ensure_schema(db)
    return cu


class QueryIn(BaseModel):
    view: str = "all"
    folder_id: Optional[int] = None
    source: str = ""
    q: str = ""
    tag: str = ""
    offset: int = Field(0, ge=0)
    limit: int = Field(25, ge=1, le=200)


class TagsIn(BaseModel):
    tags: list[str] = Field(default_factory=list, max_length=20)


class FolderIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    shared: bool = False


@router.get("/meta")
def meta(db: Session = Depends(get_tenant_db), cu: User = Depends(viewer)):
    return S.meta(db, cu, _perm(db, cu, "create"))


@router.post("/query")
def query(body: QueryIn, db: Session = Depends(get_tenant_db), cu: User = Depends(viewer)):
    view = body.view if body.view in dict(S.VIEWS) else "all"
    return S.list_docs(db, cu, view=view, folder_id=body.folder_id, source=body.source.strip()[:40], q=body.q.strip()[:120], tag=body.tag.strip()[:40],
                       offset=body.offset, limit=body.limit, can_approve=_perm(db, cu, "approve"))


@router.post("/upload", status_code=201)
async def upload(request: Request, file: UploadFile = File(...), folder_id: Optional[int] = Form(None), tags: str = Form(""), linked_source: Optional[str] = Form(None),
                 linked_record_id: Optional[int] = Form(None), version_of: Optional[int] = Form(None), doc_type: Optional[str] = Form(None), description: Optional[str] = Form(None),
                 db: Session = Depends(get_tenant_db), cu: User = Depends(creator)):
    out = await S.upload(db, cu, request, file, folder_id=folder_id, tags=[t for t in (tags or "").split(",")], linked_source=linked_source, linked_record_id=linked_record_id,
                         version_of=version_of, doc_type=doc_type, description=description)
    log_module_action(db=db, user_id=cu.id, module="document_management", action="upload", record_id=out["id"], record_name=file.filename or "Document", ip=get_request_ip(request),
                      new_data={"version": out["version"], "folder_id": folder_id})
    db.commit()
    return out


@router.get("/{rid}/versions")
def versions(rid: int, db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.versions(db, rid)}


@router.put("/{rid}/tags")
def tags(rid: int, body: TagsIn, db: Session = Depends(get_tenant_db), cu: User = Depends(viewer)):
    return {"tags": S.set_tags(db, cu, rid, body.tags)}


@router.post("/folders", status_code=201)
def create_folder(body: FolderIn, db: Session = Depends(get_tenant_db), cu: User = Depends(creator)):
    return S.create_folder(db, cu, body.name, body.shared)


@router.put("/folders/{fid}")
def rename_folder(fid: int, body: FolderIn, db: Session = Depends(get_tenant_db), cu: User = Depends(creator)):
    S.rename_folder(db, cu, fid, body.name)
    return {"ok": True}


@router.delete("/folders/{fid}")
def delete_folder(fid: int, db: Session = Depends(get_tenant_db), cu: User = Depends(creator)):
    S.delete_folder(db, cu, fid)
    return {"ok": True}
