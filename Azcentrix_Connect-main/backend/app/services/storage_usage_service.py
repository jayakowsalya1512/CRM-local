"""Tenant storage usage accounting helpers."""

from __future__ import annotations

import logging
import os
import json

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database import MasterSessionLocal, normalize_tenant_slug
from app.models.tenant import Tenant

logger = logging.getLogger(__name__)
META_SUFFIX = ".uploadmeta.json"


def tenant_file_storage_totals(tenant_slug: str) -> tuple[int, int, float]:
    """Return stored file bytes/count/MB for a tenant across upload roots."""
    normalized_slug = normalize_tenant_slug(tenant_slug)
    roots = [
        os.path.join(settings.UPLOAD_DIR, normalized_slug),
        os.path.join(settings.UPLOAD_DIR, "tenant_settings", normalized_slug),
        os.path.join(os.path.abspath(settings.MEDIA_ROOT), normalized_slug),
    ]
    seen_roots: set[str] = set()
    used_bytes = 0
    file_count = 0

    for root in roots:
        resolved_root = os.path.abspath(root)
        if resolved_root in seen_roots or not os.path.isdir(resolved_root):
            continue
        seen_roots.add(resolved_root)
        files: list[str] = []
        for dirpath, _, filenames in os.walk(resolved_root):
            for fname in filenames:
                files.append(os.path.join(dirpath, fname))

        skipped_paths: set[str] = set()
        for fpath in files:
            if not fpath.endswith(META_SUFFIX):
                continue
            try:
                with open(fpath, "r", encoding="utf-8") as meta_file:
                    meta = json.load(meta_file)
                stored_size = int(meta.get("stored_size") or meta.get("original_size") or 0)
                if stored_size <= 0:
                    continue
                used_bytes += stored_size
                file_count += 1
                skipped_paths.add(os.path.abspath(fpath))
                logical_path = fpath[: -len(META_SUFFIX)]
                skipped_paths.add(os.path.abspath(logical_path))
                physical_name = meta.get("physical_name")
                if physical_name:
                    skipped_paths.add(os.path.abspath(os.path.join(os.path.dirname(fpath), str(physical_name))))
            except Exception:
                logger.debug("Could not read tenant storage metadata: %s", fpath, exc_info=True)

        for fpath in files:
            try:
                resolved_file = os.path.abspath(fpath)
                if resolved_file in skipped_paths or fpath.endswith(META_SUFFIX):
                    continue
                used_bytes += os.path.getsize(fpath)
                file_count += 1
            except OSError:
                logger.debug("Could not stat tenant storage file: %s", fpath, exc_info=True)

    used_mb = round(used_bytes / (1024 * 1024), 2)
    return used_bytes, file_count, used_mb


def refresh_tenant_storage_usage(db: Session, tenant: Tenant) -> tuple[int, int, float]:
    """
    Refresh platform storage columns for a tenant.

    used_storage is the tenant's uploaded file/media usage in MB.
    """
    used_bytes, file_count, used_mb = tenant_file_storage_totals(tenant.slug)

    previous_used_mb = float(getattr(tenant, "used_storage", 0) or 0)
    if abs(previous_used_mb - used_mb) >= 0.01:
        tenant.used_storage = used_mb
        db.add(tenant)

    return used_bytes, file_count, used_mb


def refresh_tenant_storage_usage_for_slug(tenant_slug: str) -> tuple[float, int] | None:
    """Refresh and commit storage usage for a tenant slug in the master DB."""
    safe_slug = normalize_tenant_slug(tenant_slug)
    master_db = MasterSessionLocal()
    try:
        tenant = master_db.query(Tenant).filter(Tenant.slug == safe_slug).first()
        if not tenant:
            return None
        _, _, total_used_mb = refresh_tenant_storage_usage(master_db, tenant)
        limit_mb = int(getattr(tenant, "storage_limit_mb", 0) or 1024)
        master_db.commit()
        return total_used_mb, limit_mb
    except Exception:
        master_db.rollback()
        logger.warning("Failed to refresh storage usage for tenant=%s", safe_slug, exc_info=True)
        return None
    finally:
        master_db.close()


def ensure_tenant_storage_available(tenant_slug: str | None, extra_bytes: int) -> None:
    """Raise 413 when adding extra bytes would exceed the tenant storage limit."""
    if not tenant_slug or extra_bytes <= 0:
        return

    usage = refresh_tenant_storage_usage_for_slug(tenant_slug)
    if not usage:
        return

    used_mb, limit_mb = usage
    projected_mb = used_mb + (extra_bytes / (1024 * 1024))
    if limit_mb and projected_mb > limit_mb:
        raise HTTPException(status_code=413, detail="Storage limit exceeded.")
