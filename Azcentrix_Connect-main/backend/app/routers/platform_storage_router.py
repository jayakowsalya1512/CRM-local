"""Documents & Storage module: tenant file storage, tiers, malware scanning, quarantine, orphans and lifecycle policies.

Paths sit under ``/storage`` so the Documents & Storage permission of the caller's platform role applies (view to read,
manage for everything else). Staff with assigned scope only see and act on their tenants' files; lifecycle policies
and the orphan scan cover every tenant, so they need all-tenant scope.
"""

from __future__ import annotations

import io
import logging
from datetime import datetime, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_monitoring import PlatformTenantUsageHour
from app.models.platform_storage import PlatformStorageFile, PlatformStoragePolicy
from app.models.tenant import Tenant
from app.routers.platform_router import _get_platform_admin
from app.services import platform_storage as storage
from app.services.platform_access import enforce_platform_access, require_tenant_in_scope, scoped_tenant_ids

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/platform/storage", dependencies=[Depends(enforce_platform_access)])

MB = 1024 * 1024


def _tenants(db: Session, request: Request) -> dict[str, Tenant]:
    query = db.query(Tenant)
    allowed = scoped_tenant_ids(request)
    if allowed is not None:
        query = query.filter(Tenant.id.in_(allowed or [0]))
    return {t.slug: t for t in query.all()}


def _rows(db: Session, tenants: dict[str, Tenant]) -> list[PlatformStorageFile]:
    if not tenants:
        return []
    return db.query(PlatformStorageFile).filter(PlatformStorageFile.tenant_slug.in_(list(tenants))).all()


def _tier(row: PlatformStorageFile, now: datetime) -> str:
    if row.cold:
        return "Cold"
    touched = max(row.last_accessed_at or datetime.min, row.uploaded_at or datetime.min)
    return "Hot" if touched >= now - timedelta(days=storage.HOT_DAYS) else "Warm"


def _scan_label(row: PlatformStorageFile) -> str:
    if row.quarantined:
        return "Quarantined"
    return {"clean": "Verified", "released": "Released", "infected": "Infected", "error": "Scan error"}.get(row.scan_status, "Not scanned")


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() + "Z" if value else None


def _file(row: PlatformStorageFile, tenant: Tenant, now: datetime) -> dict:
    return {
        "id": row.id, "name": row.name, "ext": row.ext, "root": row.root,
        "tenant": {"id": tenant.id, "name": tenant.name, "slug": tenant.slug},
        "size": row.size_bytes, "original_size": row.original_bytes, "owner": row.owner,
        "uploaded_at": _iso(row.uploaded_at), "last_accessed_at": _iso(row.last_accessed_at),
        "tier": _tier(row, now), "scan": _scan_label(row), "scan_detail": row.scan_detail, "scanned_at": _iso(row.scanned_at),
        "quarantined": row.quarantined, "quarantine_reason": row.quarantine_reason, "quarantined_at": _iso(row.quarantined_at),
        "links": row.links, "deleted_links": row.deleted_links, "refs": row.refs or [], "shared": row.shared_bytes > 0,
    }


def _state(db: Session, key: str) -> Optional[PlatformStoragePolicy]:
    return db.get(PlatformStoragePolicy, key)


def _storage_trend(db: Session, slugs: list[str]) -> list[Optional[float]]:
    """Daily total of the hourly storage snapshots (Usage Monitoring meter), last 30 days, in MB."""
    if not slugs:
        return []
    now_hour = int(datetime.utcnow().timestamp() // 3600)
    rows = db.query(PlatformTenantUsageHour.hour, PlatformTenantUsageHour.tenant_slug, PlatformTenantUsageHour.value).filter(
        PlatformTenantUsageHour.meter == "storage_mb", PlatformTenantUsageHour.hour > now_hour - 30 * 24,
        PlatformTenantUsageHour.tenant_slug.in_(slugs)).all()
    latest: dict[tuple[int, str], tuple[int, float]] = {}
    for hour, slug, value in rows:
        day = (now_hour - hour) // 24
        if (day, slug) not in latest or hour > latest[(day, slug)][0]:
            latest[(day, slug)] = (hour, value)
    days = sorted({day for day, _ in latest}, reverse=True)
    return [round(sum(v for (d, _), (_, v) in latest.items() if d == day), 2) for day in days]


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    storage.ensure_schema()
    tenants = _tenants(db, request)
    rows = _rows(db, tenants)
    now = datetime.utcnow()
    live = [r for r in rows if not r.quarantined]
    total = sum(r.size_bytes for r in live)
    before = sum(r.size_bytes for r in live if r.uploaded_at and r.uploaded_at < now - timedelta(days=30))
    shared = sum(r.shared_bytes for r in live)
    groups: dict[tuple, list[PlatformStorageFile]] = {}
    for r in live:
        if r.sha256:
            groups.setdefault((r.tenant_slug, r.sha256), []).append(r)
    duplicate = sum(sum(x.size_bytes for x in g[1:]) for g in groups.values() if len(g) > 1)
    orphans = [r for r in live if r.links == 0 and r.deleted_links == 0]
    tiers = {"Hot": 0, "Warm": 0, "Cold": 0}
    tier_files = {"Hot": 0, "Warm": 0, "Cold": 0}
    by_type: dict[str, int] = {}
    by_tenant: dict[str, int] = {slug: 0 for slug in tenants}
    for r in live:
        t = _tier(r, now)
        tiers[t] += r.size_bytes
        tier_files[t] += 1
        by_type[(r.ext or "none").upper()] = by_type.get((r.ext or "none").upper(), 0) + r.size_bytes
        by_tenant[r.tenant_slug] = by_tenant.get(r.tenant_slug, 0) + r.size_bytes
    index_state, refs_state, access_state = _state(db, "_index"), _state(db, "_refs"), _state(db, "_access")
    scanner = storage.scanner()
    cold = storage.cold_status()
    scanned = [r for r in rows if r.scan_status in ("clean", "infected", "released")]
    policies = []
    for key, label, _ in storage.POLICIES:
        p = _state(db, key)
        policies.append({"key": key, "label": label, "enabled": bool(p and p.enabled), "unavailable": storage.policy_availability(key),
                         "updated_by": p.updated_by if p else None, "updated_at": _iso(p.updated_at) if p else None,
                         "last_run_at": _iso(p.last_run_at) if p else None, "last_result": p.last_result if p else None,
                         "last_error": p.last_error if p else None})
    listing = sorted(live, key=lambda r: r.size_bytes, reverse=True)[:storage.FILE_LIST_LIMIT]
    return {
        "generated_at": _iso(now),
        "indexed": index_state is not None and index_state.last_run_at is not None,
        "kpis": {
            "total_bytes": total,
            "files": len(live),
            "growth_30d": round((total - before) / before * 100, 1) if before else None,
            "dedup_saved_bytes": shared,
            "dedup_percent": round(shared / total * 100, 1) if total else None,
            "dedup_potential_bytes": max(0, duplicate - shared),
            "quarantined": sum(1 for r in rows if r.quarantined),
            "orphaned": len(orphans) if refs_state and refs_state.last_run_at else None,
            "orphaned_bytes": sum(r.size_bytes for r in orphans),
            "cold_percent": round(tier_files["Cold"] / len(live) * 100, 1) if live and cold["configured"] else None,
            "cold_bytes": tiers["Cold"],
            "scanned_percent": round(len(scanned) / len(rows) * 100, 1) if rows else None,
            "trend_mb": _storage_trend(db, list(tenants)),
        },
        "by_tenant": sorted(({"tenant_id": tenants[s].id, "name": tenants[s].name, "slug": s, "bytes": b} for s, b in by_tenant.items() if s in tenants),
                            key=lambda x: -x["bytes"]),
        "by_type": sorted(({"type": k, "bytes": v} for k, v in by_type.items()), key=lambda x: -x["bytes"]),
        "by_tier": [{"tier": k, "bytes": v, "files": tier_files[k]} for k, v in tiers.items()],
        "files": [_file(r, tenants[r.tenant_slug], now) for r in listing],
        "files_total": len(live),
        "quarantine": [_file(r, tenants[r.tenant_slug], now) for r in sorted((r for r in rows if r.quarantined), key=lambda r: r.quarantined_at or now, reverse=True)],
        "policies": policies,
        "scanner": {k: scanner[k] for k in ("available", "name", "error")},
        "cold_storage": cold,
        "jobs": {
            "running": storage.is_running(),
            "indexed_at": _iso(index_state.last_run_at) if index_state else None,
            "index_error": index_state.last_error if index_state else None,
            "references_at": _iso(refs_state.last_run_at) if refs_state else None,
            "references_result": refs_state.last_result if refs_state else None,
            "references_error": refs_state.last_error if refs_state else None,
            "access_tracking_since": _iso(access_state.last_run_at) if access_state else None,
        },
        "all_scope": scoped_tenant_ids(request) is None,
    }


def _audit(db: Session, request: Request, action: str, row: Optional[PlatformStorageFile], description: str, new: Optional[dict] = None) -> None:
    storage._audit(db, _get_platform_admin(request), action, row, description, get_request_ip(request), new)


def _require_all_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Only staff with all-tenant scope can change storage-wide settings.")


def _load(db: Session, request: Request, file_id: int) -> tuple[PlatformStorageFile, Tenant]:
    row = db.get(PlatformStorageFile, file_id)
    tenant = db.query(Tenant).filter(Tenant.slug == row.tenant_slug).first() if row else None
    if row is None or tenant is None:
        raise HTTPException(status_code=404, detail="File not found – it may have been removed since the page loaded")
    require_tenant_in_scope(request, tenant.id)
    return row, tenant


def _notify_deleted(tenant: Tenant, names: list[str], reason: str) -> str:
    from app.services.platform_monitoring import _send_email

    if not tenant.admin_email:
        return "tenant admin not notified: no admin e-mail on file"
    body = (f"The platform team permanently deleted {len(names)} file(s) from your workspace {tenant.name}:\n\n"
            + "\n".join(f"  • {n}" for n in names[:50]) + (f"\n  … and {len(names) - 50} more" if len(names) > 50 else "")
            + f"\n\nReason: {reason or 'not given'}\n\nRecords that referred to these files will show them as missing.")
    result = _send_email([tenant.admin_email], f"Files deleted from {tenant.name}", body)
    return f"tenant admin {result}"


class BulkBody(BaseModel):
    action: Literal["cold", "quarantine", "delete"]
    ids: list[int] = Field(min_length=1, max_length=1000)
    reason: str = Field("", max_length=400)


@router.post("/files/bulk")
def bulk(body: BulkBody, request: Request, db: Session = Depends(get_master_db_dep)):
    if body.action in ("quarantine", "delete") and not body.reason.strip():
        raise HTTPException(status_code=400, detail="Give a reason – it is recorded in the audit log")
    results, deleted = [], {}
    for file_id in dict.fromkeys(body.ids):
        try:
            row, tenant = _load(db, request, file_id)
        except HTTPException as exc:
            results.append({"id": file_id, "ok": False, "error": exc.detail})
            continue
        name = row.name
        try:
            if body.action == "cold":
                storage.move_to_cold(db, row)
                _audit(db, request, "storage_move_cold", row, f"Moved {name} ({tenant.slug}) to cold storage")
            elif body.action == "quarantine":
                if row.quarantined:
                    raise ValueError("Already in quarantine")
                storage.quarantine(db, row, f"Manual: {body.reason.strip()}")
                _audit(db, request, "storage_quarantine", row, f"Quarantined {name} ({tenant.slug}): {body.reason.strip()}")
            else:
                _audit(db, request, "storage_delete", row, f"Deleted {name} ({tenant.slug}): {body.reason.strip()}",
                       {"links": row.links, "refs": row.refs, "size": row.size_bytes})
                storage.delete(db, row)
                deleted.setdefault(tenant.id, (tenant, []))[1].append(name)
            db.commit()
            results.append({"id": file_id, "ok": True})
        except Exception as exc:
            db.rollback()
            logger.warning("Storage %s failed for file %s", body.action, file_id, exc_info=True)
            results.append({"id": file_id, "ok": False, "error": str(exc) or type(exc).__name__})
    notices = [_notify_deleted(tenant, names, body.reason.strip()) for tenant, names in deleted.values()]
    return {"results": results, "done": sum(1 for r in results if r["ok"]), "failed": sum(1 for r in results if not r["ok"]), "notices": notices}


class ReleaseBody(BaseModel):
    note: str = Field(..., min_length=3, max_length=400)


@router.post("/files/{file_id}/release")
def release_file(file_id: int, body: ReleaseBody, request: Request, db: Session = Depends(get_master_db_dep)):
    row, tenant = _load(db, request, file_id)
    reason = row.quarantine_reason
    try:
        storage.release(db, row)
    except (ValueError, FileNotFoundError, FileExistsError) as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc))
    _audit(db, request, "storage_release", row, f"Released {row.name} ({tenant.slug}) from quarantine after manual review: {body.note.strip()}",
           {"quarantine_reason": reason})
    db.commit()
    return {"ok": True}


class DeleteBody(BaseModel):
    reason: str = Field(..., min_length=3, max_length=400)


@router.post("/files/{file_id}/delete")
def delete_file(file_id: int, body: DeleteBody, request: Request, db: Session = Depends(get_master_db_dep)):
    row, tenant = _load(db, request, file_id)
    name = row.name
    _audit(db, request, "storage_delete", row, f"Deleted {name} ({tenant.slug}): {body.reason.strip()}",
           {"links": row.links, "refs": row.refs, "quarantine_reason": row.quarantine_reason})
    try:
        storage.delete(db, row)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=f"Delete failed: {exc}")
    return {"ok": True, "notice": _notify_deleted(tenant, [name], body.reason.strip())}


class PolicyBody(BaseModel):
    enabled: bool


@router.patch("/policies/{key}")
def set_policy(key: str, body: PolicyBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request)
    if key not in storage.POLICY_LABELS:
        raise HTTPException(status_code=404, detail="Unknown policy")
    storage.ensure_schema()
    if body.enabled and (reason := storage.policy_availability(key)):
        raise HTTPException(status_code=409, detail=f"Can't enable: {reason}")
    policy = db.get(PlatformStoragePolicy, key)
    admin = _get_platform_admin(request)
    old = policy.enabled
    policy.enabled, policy.updated_by, policy.updated_at = body.enabled, admin.email if admin else None, datetime.utcnow()
    _audit(db, request, "storage_policy", None, f"{'Enabled' if body.enabled else 'Disabled'} storage policy “{storage.POLICY_LABELS[key]}”",
           {"key": key, "enabled": body.enabled, "was": old})
    db.commit()
    if body.enabled and key == "block_exec":
        from app.utils import file_storage

        file_storage._block_exec_cache = (0.0, True)
    return {"ok": True}


@router.post("/orphan-scan", status_code=202)
def orphan_scan(request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request)
    started = storage.request_orphan_scan()
    _audit(db, request, "storage_orphan_scan", None, "Started an orphan scan of every tenant's files")
    db.commit()
    return {"started": started, "queued": not started}


@router.get("/report")
def report(request: Request, db: Session = Depends(get_master_db_dep)):
    """Storage report workbook: summary per tenant and every file, limited to the caller's tenants."""
    from openpyxl import Workbook
    from openpyxl.styles import Font

    storage.ensure_schema()
    tenants = _tenants(db, request)
    rows = _rows(db, tenants)
    now = datetime.utcnow()
    book = Workbook()
    summary = book.active
    summary.title = "Summary"
    summary.append(["Storage report", now.strftime("%d %b %Y %H:%M UTC")])
    summary.append([])
    head = ["Tenant", "Slug", "Files", "Stored MB", "Uploaded MB", "Hot MB", "Warm MB", "Cold MB", "Shared (dedup) MB",
            "Orphaned files", "Orphaned MB", "Quarantined", "Verified", "Not scanned", "Storage limit MB"]
    summary.append(head)
    for slug, tenant in sorted(tenants.items(), key=lambda x: x[1].name.lower()):
        mine = [r for r in rows if r.tenant_slug == slug]
        live = [r for r in mine if not r.quarantined]
        tier = lambda t: round(sum(r.size_bytes for r in live if _tier(r, now) == t) / MB, 2)  # noqa: E731
        orphans = [r for r in live if r.links == 0 and r.deleted_links == 0]
        summary.append([tenant.name, slug, len(live), round(sum(r.size_bytes for r in live) / MB, 2), round(sum(r.original_bytes for r in live) / MB, 2),
                        tier("Hot"), tier("Warm"), tier("Cold"), round(sum(r.shared_bytes for r in live) / MB, 2), len(orphans),
                        round(sum(r.size_bytes for r in orphans) / MB, 2), sum(1 for r in mine if r.quarantined),
                        sum(1 for r in mine if r.scan_status == "clean" and not r.quarantined), sum(1 for r in mine if r.scan_status == "pending"),
                        tenant.storage_limit_mb])
    files = book.create_sheet("Files")
    files.append(["File", "Tenant", "Folder", "Path", "Size MB", "Uploaded MB", "Owner", "Uploaded", "Last accessed", "Tier", "Scan",
                  "Scan detail", "Links", "Soft-deleted links", "References", "SHA-256"])
    for r in sorted(rows, key=lambda r: -r.size_bytes):
        files.append([r.name, tenants[r.tenant_slug].name, r.root, r.rel_path, round(r.size_bytes / MB, 3), round(r.original_bytes / MB, 3),
                      r.owner, r.uploaded_at, r.last_accessed_at, _tier(r, now), _scan_label(r), r.scan_detail or r.quarantine_reason,
                      r.links, r.deleted_links, ", ".join(r.refs or []), r.sha256])
    for sheet, row in ((summary, 3), (files, 1)):
        for cell in sheet[row]:
            cell.font = Font(bold=True)
    out = io.BytesIO()
    book.save(out)
    out.seek(0)
    _audit(db, request, "storage_report", None, f"Exported the storage report ({len(rows)} files, {len(tenants)} tenants)")
    db.commit()
    name = f"storage-report-{now:%Y-%m-%d}.xlsx"
    return StreamingResponse(out, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})
