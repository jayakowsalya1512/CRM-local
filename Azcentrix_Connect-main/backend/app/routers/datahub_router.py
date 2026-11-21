"""Data Hub (prototype v17 R.datahub).  Mounted at /api/v1/datahub

Import       GET /import/columns?obj · POST /import/log           (the file goes to the module's own /import endpoint)
Migration    GET /migration · POST /migration
Duplicates   GET /duplicates?obj · POST /duplicates/merge · POST /duplicates/ignore
Mass update  GET /mass-update/fields?module · POST /mass-update · POST /jobs/{id}/undo
Exports      GET /jobs?kind · POST /exports · GET /jobs/{id}/download
The recycle bin stays on /api/v1/recycle-bin.  Reads: datahub.view; writes: datahub.manage (admin / ceo always pass).
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.logging import log_audit_db
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.services import datahub_service as S

router = APIRouter(tags=["Data Hub"])
ADMIN = ("admin", "ceo")
VIEW = ("admin", "ceo", "manager", "vp")


def viewer(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if (cu.role or "") not in VIEW and not user_has_permission(db, cu, "datahub.view"):
        raise HTTPException(403, "You don't have access to the Data Hub")
    S.ensure_schema(db)
    return cu


def manager(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if (cu.role or "") not in ADMIN and not user_has_permission(db, cu, "datahub.manage"):
        raise HTTPException(403, "You don't have permission to change data in bulk")
    S.ensure_schema(db)
    return cu


def _audit(db: Session, request: Request, cu: User, action: str, rid: Optional[int], text: str) -> None:
    try:
        log_audit_db(db, cu.id, "datahub", action, rid, get_request_ip(request), text)
        db.commit()
    except Exception:
        db.rollback()


class ImportLogIn(BaseModel):
    object: str
    file_name: str = Field("", max_length=200)
    rows_total: int = 0
    created: int = 0
    duplicates: int = 0
    errors: int = 0
    detail: dict[str, Any] = Field(default_factory=dict)


class MigrationIn(BaseModel):
    source: str = Field(..., max_length=60)
    config: dict[str, Any] = Field(default_factory=dict)
    objects: list[str] = Field(default_factory=list, max_length=30)
    notes: str = Field("", max_length=2000)


class PairIn(BaseModel):
    object: str
    keep_id: int
    drop_id: int


class MassIn(BaseModel):
    module: str
    field: str
    value: Any = None
    scope: str = "all"


class ExportIn(BaseModel):
    object: str = "all"


@router.get("/meta")
def meta(db: Session = Depends(get_tenant_db), cu: User = Depends(viewer)):
    return {"tabs": S.TABS, "import_objects": [{"k": k, "l": v[0]} for k, v in S.IMPORT_OBJECTS.items()], "export_objects": [{"k": k, "l": v[0]} for k, v in S.EXPORT_OBJECTS.items()],
            "mass_modules": [{"k": k, "l": v} for k, v in S.MASS_LABELS.items()], "can_manage": (cu.role or "") in ADMIN or user_has_permission(db, cu, "datahub.manage")}


@router.get("/import/columns")
def import_columns(obj: str, _: User = Depends(viewer)):
    return S.import_columns(obj)


@router.post("/import/log", status_code=201)
def import_log(body: ImportLogIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(viewer)):
    jid = S.log_import(db, cu, body.object, body.file_name, body.rows_total, body.created, body.duplicates, body.errors, body.detail)
    _audit(db, request, cu, "import", jid, f"Import {body.object}: {body.created} created, {body.duplicates} duplicates, {body.errors} errors")
    return {"id": jid}


@router.get("/migration")
def migration(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return S.migration(db)


@router.post("/migration", status_code=201)
def request_migration(body: MigrationIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    out = S.request_migration(db, cu, body.source, body.config, body.objects, body.notes)
    _audit(db, request, cu, "migration_request", out["id"], f"Migration from {body.source} requested ({out['status']})")
    return out


@router.get("/duplicates")
def duplicates(obj: str = "customers", db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.duplicates(db, obj)}


@router.post("/duplicates/merge")
def merge(body: PairIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    out = S.merge(db, cu, body.object, body.keep_id, body.drop_id)
    _audit(db, request, cu, "merge", body.keep_id, f"{body.object}: #{body.drop_id} merged into #{body.keep_id}")
    return out


@router.post("/duplicates/ignore")
def ignore(body: PairIn, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.ignore_pair(db, cu, body.object, body.keep_id, body.drop_id)
    return {"ok": True}


@router.get("/mass-update/fields")
def mass_fields(module: str = "leads", db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return S.mass_fields(db, module)


@router.post("/mass-update")
def mass_update(body: MassIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    out = S.mass_update(db, cu, body.module, body.field, body.value, body.scope)
    _audit(db, request, cu, "mass_update", out["job_id"], f"{body.module}.{body.field} set on {out['updated']} records")
    return out


@router.post("/jobs/{job_id}/undo")
def undo(job_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    n = S.undo(db, cu, job_id)
    _audit(db, request, cu, "mass_update_undo", job_id, f"Mass update #{job_id} undone on {n} records")
    return {"restored": n}


@router.get("/jobs")
def jobs(kind: str = "export", offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=200), db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    kinds = {"export": ("export", "backup"), "import": ("import",), "mass_update": ("mass_update", "merge")}.get(kind, ("export", "backup"))
    return S.jobs(db, kinds, offset, limit)


@router.post("/exports", status_code=201)
def start_export(body: ExportIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    jid = S.start_export(db, cu, body.object)
    _audit(db, request, cu, "export", jid, f"Export started: {body.object}")
    return {"id": jid}


@router.get("/jobs/{job_id}/download")
def download(job_id: int, db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    path, name = S.download(db, job_id)
    return FileResponse(path, filename=name, media_type="application/zip" if name.endswith(".zip") else "text/csv")
