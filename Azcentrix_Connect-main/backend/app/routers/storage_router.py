from pydantic import BaseModel
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.core.config import settings
from app.dependencies import get_current_user, get_tenant_db
from app.models.all_models import User
from app.services.storage_usage_service import ensure_tenant_storage_available
from app.utils.file_storage import (
    media_url_to_logical_path,
    stored_file_accounted_size,
    stored_upload_accounted_size,
)


router = APIRouter()


class StorageCheckIn(BaseModel):
    extra_bytes: int
    replace_file_url: str | None = None


def _replace_file_size(file_url: str | None) -> int:
    if not file_url:
        return 0
    try:
        if str(file_url).startswith("/uploads/"):
            logical_path = media_url_to_logical_path(
                root_dir=settings.UPLOAD_DIR,
                file_url=file_url,
                url_prefix="/uploads",
            )
        else:
            logical_path = media_url_to_logical_path(
                root_dir=settings.MEDIA_ROOT,
                file_url=file_url,
            )
        return stored_file_accounted_size(logical_path)
    except Exception:
        return 0


@router.post("/check")
def check_storage_available(
    data: StorageCheckIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    extra_bytes = max(0, int(data.extra_bytes or 0) - _replace_file_size(data.replace_file_url))
    ensure_tenant_storage_available(tenant_slug, extra_bytes)
    return {"ok": True}


@router.post("/check-file")
async def check_file_storage_available(
    files: list[UploadFile] = File(...),
    replace_file_url: str | None = Form(None),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    if not files:
        raise HTTPException(status_code=400, detail="No file selected.")

    stored_bytes = 0
    for upload in files:
        contents = await upload.read()
        if not contents:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")
        stored_bytes += stored_upload_accounted_size(
            original_filename=upload.filename,
            contents=contents,
            content_type=upload.content_type,
        )

    extra_bytes = max(0, stored_bytes - _replace_file_size(replace_file_url))
    ensure_tenant_storage_available(tenant_slug, extra_bytes)
    return {"ok": True, "stored_bytes": stored_bytes}
