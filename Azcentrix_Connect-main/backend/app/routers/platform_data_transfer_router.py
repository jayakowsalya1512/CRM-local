"""Data Export & Migration module: every tenant's export jobs and migration projects, and the source connectors.

Paths sit under ``/data-transfer`` (Data Export & Migration permission: view to read, manage to change). Exports and
migrations themselves run through the tenant routes (``/tenants/{id}/exports|migrations``), which the same permission
opens and which check the tenant against the caller's scope. Connector credentials serve every tenant, so changing
them needs all-tenant scope.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.tenant import Tenant
from app.models.tenant_hierarchy import PlatformMigrationConnector, TenantExportJob, TenantMigration
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.routers.platform_tenant_hierarchy_router import _export_row, _migration_row
from app.services import migration_connectors as mc
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/platform/data-transfer", dependencies=[Depends(enforce_platform_access)])


def _tenants(db: Session, request: Request) -> list[Tenant]:
    query = db.query(Tenant)
    allowed = scoped_tenant_ids(request)
    if allowed is not None:
        query = query.filter(Tenant.id.in_(allowed or [0]))
    return query.order_by(Tenant.name).all()


def _connector_row(source: str, row: Optional[PlatformMigrationConnector]) -> dict:
    if source in mc.FILE_SOURCES:
        method, objects = mc.FILE_INFO[source]
        return {"source": source, "kind": "file", "method": method, "objects": [{"name": o, "count": None} for o in objects], "fields": [],
                "status": "ready", "account": None, "detail": "Upload the files in the migration wizard – no connection needed", "validated_at": None}
    connector = mc.CONNECTORS[source]
    config = mc.decrypt_config(row.config) if row and row.config else {}
    fields = [{"key": k, "label": label, "secret": secret, "value": None if secret else config.get(k, ""), "set": bool(config.get(k))}
              for k, label, secret in connector.fields]
    objects = (row.objects if row and row.objects else None) or [{"name": o, "count": None} for o in connector.objects]
    return {"source": source, "kind": "api", "method": connector.method, "objects": objects, "fields": fields,
            "status": row.status if row else "not_configured", "account": row.account if row else None,
            "detail": row.detail if row else "Not configured", "validated_at": row.validated_at if row else None,
            "updated_by": row.updated_by if row else None}


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    tenants = _tenants(db, request)
    names = {t.id: t for t in tenants}
    ids = list(names) or [0]
    exports = db.query(TenantExportJob).filter(TenantExportJob.tenant_id.in_(ids)).order_by(TenantExportJob.id.desc()).limit(500).all()
    migrations = db.query(TenantMigration).filter(TenantMigration.tenant_id.in_(ids)).order_by(TenantMigration.id.desc()).limit(500).all()
    tenant = lambda tid: {"id": tid, "name": names[tid].name, "slug": names[tid].slug}  # noqa: E731
    saved = {c.source: c for c in db.query(PlatformMigrationConnector).all()}
    return {
        "generated_at": datetime.now(),
        "tenants": [{"id": t.id, "name": t.name, "slug": t.slug, "status": t.status} for t in tenants],
        "exports": [{**_export_row(j), "tenant": tenant(j.tenant_id)} for j in exports],
        "migrations": [{**_migration_row(m), "tenant": tenant(m.tenant_id)} for m in migrations],
        "connectors": [_connector_row(s, saved.get(s)) for s in mc.SOURCES],
        "all_scope": scoped_tenant_ids(request) is None,
    }


def _require_all_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Only staff with all-tenant scope can change source connectors.")


def _connector(source: str) -> type:
    if source not in mc.CONNECTORS:
        raise HTTPException(status_code=404, detail="Unknown connector" if source not in mc.FILE_SOURCES else "File sources need no connection")
    return mc.CONNECTORS[source]


def _validate(db: Session, request: Request, source: str, row: PlatformMigrationConnector, config: dict, action: str) -> dict:
    admin = _get_platform_admin(request)
    try:
        result = mc.validate(source, config)
        row.status, row.account, row.objects = "connected", (result["account"] or "")[:255], result["objects"]
        row.detail = f"Connected as {result['account']}" if result["account"] else "Connected"
    except mc.ConnectorError as exc:
        row.status, row.detail = "failed", str(exc)[:1000]
    except Exception as exc:  # an unexpected vendor response must not look like a success
        logger.warning("Connector %s validation error", source, exc_info=True)
        row.status, row.detail = "failed", f"Validation failed: {exc.__class__.__name__}: {str(exc)[:200]}"
    row.validated_at = datetime.now()
    row.updated_by = (getattr(admin, "email", None) or "platform admin")[:200]
    _write_platform_audit(db, admin, action, "migration_connector", None, source,
                          f"{source} connector {'validated' if row.status == 'connected' else 'failed validation'}: {row.detail}", get_request_ip(request))
    db.commit()
    return _connector_row(source, row)


class ConnectorConfig(BaseModel):
    config: dict[str, str]


@router.put("/connectors/{source}")
def save_connector(source: str, data: ConnectorConfig, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request)
    connector = _connector(source)
    row = db.get(PlatformMigrationConnector, source) or PlatformMigrationConnector(source=source)
    db.add(row)
    current = mc.decrypt_config(row.config)
    allowed = {k for k, _, _ in connector.fields}
    config = {k: (v or "").strip() for k, v in data.config.items() if k in allowed}
    secrets_ = {k for k, _, secret in connector.fields if secret}
    merged = {**current, **{k: v for k, v in config.items() if v or k not in secrets_}}  # a blank secret keeps the stored one
    row.config = mc.encrypt_config(merged)
    return _validate(db, request, source, row, merged, "save_migration_connector")


@router.post("/connectors/{source}/test")
def test_connector(source: str, request: Request, db: Session = Depends(get_master_db_dep)):
    _connector(source)
    row = db.get(PlatformMigrationConnector, source)
    if not row or not row.config:
        raise HTTPException(status_code=409, detail=f"{source} is not configured")
    return _validate(db, request, source, row, mc.decrypt_config(row.config), "test_migration_connector")


@router.delete("/connectors/{source}")
def remove_connector(source: str, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request)
    _connector(source)
    row = db.get(PlatformMigrationConnector, source)
    if row:
        db.delete(row)
        _write_platform_audit(db, _get_platform_admin(request), "remove_migration_connector", "migration_connector", None, source,
                              f"{source} connector removed (stored credentials deleted)", get_request_ip(request))
        db.commit()
    return _connector_row(source, None)

