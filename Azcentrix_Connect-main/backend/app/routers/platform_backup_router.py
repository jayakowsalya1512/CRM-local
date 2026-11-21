import logging
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from app.database import get_master_db_dep, get_tenant_engine_by_db_name
from sqlalchemy import text
from app.services.platform_access import enforce_platform_access, require_tenant_in_scope, scoped_tenant_ids
from app.models.tenant import Tenant
from app.models.platform_backup import TenantBackup
from app.services.platform_backup_service import (
    BACKUP_DIR, FREQUENCIES, MODULES, OTHER_MODULE, export_modules, run_backup, tenant_module_storage,
)

router = APIRouter(prefix='/api/v1/platform/backups', dependencies=[Depends(enforce_platform_access)])
class BackupRequest(BaseModel):
    tenant_id: int
    name: str = Field(default='', max_length=200)
    frequency: str | None = None

def payload(b):
    return {'id': b.id, 'tenant_id': b.tenant_id, 'name': b.name, 'frequency': b.frequency, 'status': b.status, 'created_at': b.created_at, 'completed_at': b.completed_at, 'next_run_at': b.next_run_at, 'available': bool(b.file_name and (BACKUP_DIR / b.file_name).is_file()), 'error': b.error}

@router.get('')
def list_backups(request: Request, db: Session = Depends(get_master_db_dep)):
    allowed = scoped_tenant_ids(request)
    return [payload(b) for b in db.query(TenantBackup).order_by(TenantBackup.id.desc()).all() if allowed is None or b.tenant_id in allowed]

@router.post('')
def create_backup(data: BackupRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    require_tenant_in_scope(request, data.tenant_id)
    tenant = db.get(Tenant, data.tenant_id)
    if not tenant: raise HTTPException(404, 'Tenant not found')
    if data.frequency and data.frequency not in FREQUENCIES: raise HTTPException(400, 'Invalid schedule frequency')
    backup = TenantBackup(tenant_id=tenant.id, name=data.name.strip() or 'Tenant backup', frequency=data.frequency, status='pending')
    db.add(backup); db.commit(); db.refresh(backup)
    run_backup(db, backup, tenant)
    return payload(backup)

class ModuleExportRequest(BaseModel):
    modules: list[str] = Field(min_length=1)
    format: str = 'sql'


def _tenant_or_404(db: Session, tenant_id: int) -> Tenant:
    tenant = db.get(Tenant, tenant_id)
    if not tenant: raise HTTPException(404, 'Tenant not found')
    return tenant


@router.get('/tenants/{tenant_id}/module-count')
def tenant_module_count(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant_or_404(db, tenant_id)
    try:
        engine = get_tenant_engine_by_db_name(tenant.db_name)
        with engine.connect() as connection:
            count = connection.execute(text('SELECT COUNT(*) FROM modules WHERE is_active = 1')).scalar_one()
        return {'tenant_id': tenant.id, 'count': count}
    except Exception:
        logging.getLogger(__name__).exception('Module count failed for tenant %s', tenant.id)
        raise HTTPException(502, 'Unable to read active modules for this tenant')


@router.get('/tenants/{tenant_id}/database-health')
def tenant_database_health(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    """Read tenant usage and server-wide MySQL status, when permitted."""
    tenant = _tenant_or_404(db, tenant_id)
    result = {'total_bytes': None, 'health': 'unavailable', 'active_users': None,
              'connections': None, 'max_connections': None, 'running_queries': None,
              'slow_queries': None, 'uptime_seconds': None, 'checked_at': datetime.now(timezone.utc).isoformat()}
    try:
        engine = get_tenant_engine_by_db_name(tenant.db_name)
        with engine.connect() as conn:
            conn.execute(text('SELECT 1'))
            result['health'] = 'healthy'
            queries = {
                'total_bytes': ("SELECT COALESCE(SUM(COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)), 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = :db AND TABLE_TYPE = 'BASE TABLE'", {'db': tenant.db_name}),
                'active_users': ('SELECT COUNT(*) FROM users WHERE is_active = 1', {}),
            }
            for key, (sql, params) in queries.items():
                try:
                    result[key] = int(conn.execute(text(sql), params).scalar_one())
                except Exception:
                    logging.getLogger(__name__).warning('Unable to read %s for tenant %s', key, tenant.id, exc_info=True)
            try:
                rows = conn.execute(text("SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected', 'Threads_running', 'Slow_queries', 'Uptime')")).fetchall()
                status = {str(row[0]).lower(): int(row[1]) for row in rows}
                result.update(connections=status.get('threads_connected'), running_queries=status.get('threads_running'), slow_queries=status.get('slow_queries'), uptime_seconds=status.get('uptime'))
            except Exception:
                logging.getLogger(__name__).warning('Unable to read database server status for tenant %s', tenant.id, exc_info=True)
            try:
                result['max_connections'] = int(conn.execute(text("SELECT @@GLOBAL.max_connections")).scalar_one())
            except Exception:
                logging.getLogger(__name__).warning('Unable to read max connections for tenant %s', tenant.id, exc_info=True)
    except Exception:
        logging.getLogger(__name__).warning('Database unavailable for tenant %s', tenant.id, exc_info=True)
    return result


@router.get('/tenants/{tenant_id}/slow-queries')
def tenant_slow_queries(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    """Return retained slow-log entries for this tenant, if table logging is enabled."""
    tenant = _tenant_or_404(db, tenant_id)
    try:
        with get_tenant_engine_by_db_name(tenant.db_name).connect() as conn:
            variables = dict(conn.execute(text("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('slow_query_log', 'log_output')")).fetchall())
            if str(variables.get('slow_query_log', '')).upper() not in ('ON', '1'):
                return {'available': False, 'reason': 'Slow query logging is disabled on the database server.', 'queries': []}
            if 'TABLE' not in str(variables.get('log_output', '')).upper().split(','):
                return {'available': False, 'reason': 'Slow queries are logged to a file; table entries are not available.', 'queries': []}
            rows = conn.execute(text("SELECT start_time, query_time, rows_examined, rows_sent, sql_text FROM mysql.slow_log WHERE db = :db ORDER BY start_time DESC LIMIT 100"), {'db': tenant.db_name}).fetchall()
            return {'available': True, 'reason': None, 'queries': [{'started_at': str(row[0]), 'duration': str(row[1]), 'rows_examined': int(row[2]), 'rows_sent': int(row[3]), 'sql': str(row[4])} for row in rows]}
    except Exception:
        logging.getLogger(__name__).warning('Unable to read slow query log for tenant %s', tenant.id, exc_info=True)
        return {'available': False, 'reason': 'Slow query details could not be read. Check database permissions and logging configuration.', 'queries': []}


@router.get('/tenants/{tenant_id}/modules')
def tenant_modules(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant_or_404(db, tenant_id)
    try:
        modules = tenant_module_storage(tenant.db_name)
    except Exception:
        logging.getLogger(__name__).exception('Module storage lookup failed for tenant %s', tenant.id)
        raise HTTPException(502, 'Unable to read this tenant database')
    for m in modules:
        m['table_count'] = len(m.pop('tables'))
    return {'tenant_id': tenant.id, 'tenant_name': tenant.name, 'total_bytes': sum(m['storage_bytes'] for m in modules), 'modules': modules}


@router.post('/tenants/{tenant_id}/export')
def export_tenant_modules(tenant_id: int, data: ModuleExportRequest, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant_or_404(db, tenant_id)
    if data.format not in ('sql', 'csv'): raise HTTPException(400, 'Format must be sql or csv')
    valid = {key for key, _label, _ in MODULES} | {OTHER_MODULE[0]}
    if not set(data.modules) <= valid: raise HTTPException(400, 'Unknown module selected')
    workdir = Path(tempfile.mkdtemp(prefix='tenant-export-'))
    try:
        path = export_modules(tenant.db_name, data.modules, data.format, workdir)
    except ValueError as exc:
        shutil.rmtree(workdir, ignore_errors=True)
        raise HTTPException(400, str(exc))
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        logging.getLogger(__name__).exception('Module export failed for tenant %s', tenant.id)
        raise HTTPException(500, 'Export failed. Check the server logs.')
    stamp = datetime.utcnow().strftime('%Y%m%d-%H%M')
    ext, media = ('sql', 'application/sql') if data.format == 'sql' else ('zip', 'application/zip')
    return FileResponse(path, media_type=media, filename=f'{tenant.slug}-modules-{stamp}.{ext}',
                        background=BackgroundTask(shutil.rmtree, workdir, ignore_errors=True))


@router.get('/{backup_id}/download')
def download_backup(backup_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    backup = db.get(TenantBackup, backup_id)
    if not backup or backup.status != 'completed' or not backup.file_name: raise HTTPException(404, 'Backup not available')
    require_tenant_in_scope(request, backup.tenant_id)
    path = BACKUP_DIR / backup.file_name
    if not path.is_file(): raise HTTPException(404, 'Backup file not found')
    return FileResponse(path, media_type='application/sql', filename=f'tenant-{backup.tenant_id}-backup-{backup.id}.sql')
