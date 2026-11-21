import os
import shutil
import subprocess
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL
from app.core.config import settings
from app.database import validate_mysql_identifier

BACKUP_DIR = Path(os.environ.get('BACKUP_DIR', './backups')).resolve()
FREQUENCIES = {'daily': 1, 'weekly': 7, 'monthly': 30}

def _tenant_engine(db_name):
    url = URL.create('mysql+pymysql', username=settings.TENANT_DB_USER, password=settings.TENANT_DB_PASSWORD, host=settings.TENANT_DB_HOST, port=settings.TENANT_DB_PORT, database=db_name)
    return create_engine(url)


def _quote(table):
    return '`' + table.replace('`', '``') + '`'


def _sql_value(v):
    if v is None:
        return 'NULL'
    if isinstance(v, bytes):
        return "X'" + v.hex() + "'"
    if isinstance(v, bool):
        return str(int(v))
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace('\\', '\\\\').replace("'", "\\'") + "'"


def dump_database(db_name, tables=None, directory=None):
    """Write a SQL dump of the whole tenant DB, or only `tables`. Returns the file name."""
    db_name = validate_mysql_identifier(db_name, field_name='database name')
    target_dir = directory or BACKUP_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    name = f'tenant-{uuid.uuid4().hex}.sql'
    path = target_dir / name
    if tables is not None:
        tables = [validate_mysql_identifier(t, field_name='table name') for t in tables]
    executable = os.environ.get('MYSQLDUMP_PATH') or shutil.which('mysqldump')
    try:
        if executable:
            env = os.environ.copy()
            env['MYSQL_PWD'] = settings.TENANT_DB_PASSWORD
            extra = ['--routines', '--triggers'] if tables is None else []
            with path.open('wb') as output:
                subprocess.run([executable, '-h', settings.TENANT_DB_HOST, '-P', str(settings.TENANT_DB_PORT), '-u', settings.TENANT_DB_USER, '--single-transaction', *extra, db_name, *(tables or [])], stdout=output, stderr=subprocess.PIPE, env=env, check=True, timeout=600)
        else:
            engine = _tenant_engine(db_name)
            try:
                with engine.connect() as conn, path.open('w', encoding='utf-8', newline='\n') as out:
                    out.write('SET FOREIGN_KEY_CHECKS=0;\n')
                    names = tables if tables is not None else [t for (t, *_) in conn.execute(text('SHOW FULL TABLES WHERE Table_type = \'BASE TABLE\'')).fetchall()]
                    for table in names:
                        quoted = _quote(table)
                        ddl = conn.execute(text('SHOW CREATE TABLE ' + quoted)).first()[1]
                        out.write(f'DROP TABLE IF EXISTS {quoted};\n{ddl};\n')
                        result = conn.execute(text('SELECT * FROM ' + quoted))
                        columns = ', '.join(_quote(c) for c in result.keys())
                        for row in result:
                            out.write(f'INSERT INTO {quoted} ({columns}) VALUES ({", ".join(_sql_value(v) for v in row)});\n')
                    out.write('SET FOREIGN_KEY_CHECKS=1;\n')
            finally:
                engine.dispose()
        return name
    except Exception:
        path.unlink(missing_ok=True)
        raise


# ─── Module storage & export ──────────────────────────────────────────────────
# Tables are grouped by name prefix; first match wins. Anything that matches no
# rule is listed under "Other" so new tables are never hidden from exports.
MODULES = [
    ('customers', 'Customers', ('customer', 'sales_customer_assignments')),
    ('leads', 'Leads', ('lead', 'competitors')),
    ('tenders', 'Tenders & EMD/BG', ('tender', 'rfp_analyses', 'emdbg')),
    ('quotations', 'Quotations', ('quotation',)),
    ('work_orders', 'Work Orders', ('work_orders', 'wo_')),
    ('kam', 'KAM', ('kam_',)),
    ('travel', 'Travel & Claims', ('tada_', 'travel_requests')),
    ('documents', 'Documents & Letters', ('document_', 'letter')),
    ('approvals', 'Approvals & Workflows', ('approval',)),
    ('notifications', 'Notifications & Alerts', ('notification', 'alert')),
    ('reports', 'Reports & Dashboards', ('report_', 'saved_report', 'dashboard_')),
    ('users', 'Users & Roles', ('users', 'roles', 'role_permissions', 'permissions', 'groups', 'org_tree_nodes', 'user_', 'trusted_devices', 'quick_pin')),
    ('login', 'Login & Sessions', ('login_',)),
    ('audit', 'Audit Logs', ('audit_logs', 'activity_logs', 'api_logs', 'error_logs')),
    ('masters', 'Masters & Settings', ('products_master', 'oems', 'business_', 'vertical_', 'regions', 'states', 'districts', 'settings', 'tenant_settings', 'modules', 'form_fields', 'questionnaire', 'sticky_notes')),
]
OTHER_MODULE = ('other', 'Other')


def _module_for(table):
    for key, _label, prefixes in MODULES:
        if any(table == p or table.startswith(p) for p in prefixes):
            return key
    return OTHER_MODULE[0]


def tenant_module_storage(db_name):
    """Per-module table list, exact record counts and on-disk size for a tenant DB."""
    db_name = validate_mysql_identifier(db_name, field_name='database name')
    engine = _tenant_engine(db_name)
    try:
        with engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT TABLE_NAME, COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) "
                "FROM information_schema.TABLES WHERE TABLE_SCHEMA = :db AND TABLE_TYPE = 'BASE TABLE'"
            ), {'db': db_name}).fetchall()
            modules = {key: {'key': key, 'label': label, 'tables': [], 'records': 0, 'storage_bytes': 0} for key, label, _ in MODULES}
            modules[OTHER_MODULE[0]] = {'key': OTHER_MODULE[0], 'label': OTHER_MODULE[1], 'tables': [], 'records': 0, 'storage_bytes': 0}
            for table, size in rows:
                count = conn.execute(text('SELECT COUNT(*) FROM ' + _quote(table))).scalar() or 0
                module = modules[_module_for(table)]
                module['tables'].append(table)
                module['records'] += int(count)
                module['storage_bytes'] += int(size or 0)
    finally:
        engine.dispose()
    return [m for m in modules.values() if m['tables']]


def export_modules(db_name, module_keys, fmt, directory):
    """Export the selected modules as one .sql file or a .zip of CSVs. Returns the path."""
    import csv
    import zipfile
    selected = set(module_keys)
    tables = [t for m in tenant_module_storage(db_name) if m['key'] in selected for t in m['tables']]
    if not tables:
        raise ValueError('No tables found for the selected modules')
    if fmt == 'sql':
        return directory / dump_database(db_name, tables=tables, directory=directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f'tenant-{uuid.uuid4().hex}.zip'
    engine = _tenant_engine(validate_mysql_identifier(db_name, field_name='database name'))
    try:
        with engine.connect() as conn, zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
            for table in tables:
                result = conn.execute(text('SELECT * FROM ' + _quote(table)))
                with archive.open(f'{table}.csv', 'w') as raw:
                    import io
                    stream = io.TextIOWrapper(raw, encoding='utf-8-sig', newline='')
                    writer = csv.writer(stream)
                    writer.writerow(result.keys())
                    for row in result:
                        writer.writerow(['' if v is None else v.hex() if isinstance(v, bytes) else v for v in row])
                    stream.flush()
                    stream.detach()
        return path
    except Exception:
        path.unlink(missing_ok=True)
        raise
    finally:
        engine.dispose()

def run_backup(db, backup, tenant):
    backup.status = 'in_progress'
    db.commit()
    try:
        backup.file_name = dump_database(tenant.db_name)
        backup.status = 'completed'
        backup.completed_at = datetime.utcnow()
        backup.error = None
    except Exception:
        backup.status = 'failed'
        backup.error = 'Database backup failed. Check server logs.'
        import logging
        logging.getLogger(__name__).exception('Backup failed for tenant %s', tenant.id)
    if backup.frequency:
        backup.next_run_at = datetime.utcnow() + timedelta(days=FREQUENCIES[backup.frequency])
    db.commit()
