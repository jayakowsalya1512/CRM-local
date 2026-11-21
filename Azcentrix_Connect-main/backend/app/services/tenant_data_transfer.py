"""Data & migration: complete tenant data exports and migrations into a tenant.

Exports package one tenant's MariaDB database (or selected parts), its stored files and a manifest with
row counts and SHA-256 checksums into a ZIP, optionally encrypted at rest (AES-256-CTR + HMAC-SHA256),
delivered through a signed, expiring download link.

Migrations import CSV / Excel files or a SQL dump (restored into a temporary staging database) into the
tenant's Customers and Leads, with field mapping, rules, a dry run and a 7-day rollback.
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import uuid
import zipfile
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pymysql
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from jose import JWTError, jwt
from sqlalchemy import text

from app.core.config import settings
from app.database import MasterSessionLocal, get_tenant_session, master_engine, validate_mysql_identifier
from app.models.tenant import Tenant
from app.models.tenant_hierarchy import TenantExportJob
from app.services.platform_backup_service import BACKUP_DIR

logger = logging.getLogger(__name__)

EXPORT_DIR = BACKUP_DIR / "exports"
MIGRATION_DIR = BACKUP_DIR / "migrations"

# ─── Export ─────────────────────────────────────────────────────────────────

EXPORT_COMPONENTS = [
    ("database", "Database – all tables"),
    ("files", "Files & documents"),
    ("audit", "Audit & activity logs"),
    ("config", "Configuration (workflows, forms, roles, masters)"),
    ("users", "Users & permissions"),
    ("integrations", "Integration settings"),
    ("analytics", "Analytics snapshots"),
]
COMPONENT_TABLES = {
    "audit": re.compile(r"(audit|_logs?$|_history$|activity)", re.I),
    "config": re.compile(r"^(roles|permissions|role_permissions|modules|approval_|form_|notification_(rules|templates|event_definitions)|lead_(sources|categories|sub_categories)|competitors|oems|business_verticals|report_(types|type_fields|folders)|questionnaire_form_elements)", re.I),
    "users": re.compile(r"^(users|user_groups?|user_group_members|user_reporting_hierarchy|org_tree_nodes|roles|permissions|role_permissions)$", re.I),
    "integrations": re.compile(r"(integration|channel|webhook)", re.I),
    "analytics": re.compile(r"(report|dashboard|analytics|snapshot)", re.I),
}
# Prototype options; MariaDB replaces the prototype's pg_dump. Labels of older jobs keep working through the LEGACY maps.
EXPORT_FORMATS = {"SQL dump (MariaDB) + files": "sql", "CSV bundle + files": "csv", "JSON (portable) + files": "json", "Parquet (analytics)": "parquet"}
LEGACY_FORMATS = {"SQL dump + files": "sql"}
PII_MODES = ("Include", "Mask", "Exclude")
ENCRYPTIONS = ("AES-256 (platform key)", "Customer public key (PGP)", "None")
DELIVERIES = ("Secure download link", "SFTP server", "Customer S3 bucket", "Encrypted email")
LEGACY_DELIVERIES = {"Email link to tenant admin": "Encrypted email"}
INTERRUPTED = "Interrupted before it finished (server restart or crash) – retry to run it again"
# Never exported in clear: credential material in any table.
SECRET_COLUMN = re.compile(r"(password|hashed|token|secret|otp|api_key|refresh|fingerprint)", re.I)
PII_COLUMN = re.compile(r"(email|phone|mobile|address|pincode|dob|pan_number|aadhaar|linkedin|ip_address|contact_person|contact_name|full_name|personal)", re.I)
_CHUNK = 1024 * 1024


def format_key(label: str) -> str | None:
    return EXPORT_FORMATS.get(label) or LEGACY_FORMATS.get(label)


def delivery_of(job: TenantExportJob) -> str:
    return LEGACY_DELIVERIES.get(job.delivery, job.delivery)


def gpg_binary() -> str | None:
    for candidate in (getattr(settings, "GPG_BINARY", "") or None, shutil.which("gpg"),
                      r"C:\Program Files\Git\usr\bin\gpg.exe", r"C:\Program Files\GnuPG\bin\gpg.exe"):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def option_status() -> dict[str, str | None]:
    """Why an export option can't be used here (None when it can). Nothing unavailable is ever simulated."""
    try:
        import pyarrow  # noqa: F401
        parquet = None
    except ImportError:
        parquet = "Needs the pyarrow package on the server (pip install pyarrow)"
    return {"Parquet (analytics)": parquet,
            "Customer public key (PGP)": None if gpg_binary() else "GnuPG (gpg) is not installed on the server",
            "SFTP server": "No SFTP destination is configured for exports",
            "Customer S3 bucket": "No S3 destination is configured for exports"}


def _gpg(args: list[str], home: str, **kwargs):
    """Run gpg on a throw-away keyring. Public-key work needs no gpg-agent, so the exit status (which reports a missing
    agent) is not used – callers check the outcome (key listed, output written) instead."""
    import subprocess
    return subprocess.run([gpg_binary(), "--homedir", home, "--batch", "--no-tty", "--no-autostart", *args], capture_output=True, **kwargs)


def pgp_fingerprint(armored_key: str) -> str:
    """Import a customer's public key into a throw-away keyring and return its fingerprint (ValueError if unusable)."""
    if not gpg_binary():
        raise ValueError("GnuPG (gpg) is not installed on the server")
    if "BEGIN PGP PUBLIC KEY BLOCK" not in (armored_key or ""):
        raise ValueError("Paste an ASCII-armoured PGP public key (-----BEGIN PGP PUBLIC KEY BLOCK-----)")
    home = tempfile.mkdtemp(prefix="gpg-")
    try:
        imported = _gpg(["--import"], home, input=armored_key.encode(), timeout=60)
        listing = _gpg(["--with-colons", "--list-keys"], home, timeout=60).stdout.decode()
    finally:
        shutil.rmtree(home, ignore_errors=True)
    keys = [line.split(":") for line in listing.splitlines()]
    if not any(k[0] == "pub" for k in keys):
        raise ValueError(f"The PGP key could not be read: {imported.stderr.decode(errors='replace').strip()[-200:]}")
    if not any(len(k) > 11 and k[0] in ("pub", "sub") and "e" in k[11].lower() for k in keys):
        raise ValueError("The PGP key has no encryption capability")
    return next(k[9] for k in keys if k[0] == "fpr")


def _pgp_encrypt(src: Path, dst: Path, armored_key: str, fingerprint: str) -> None:
    home = tempfile.mkdtemp(prefix="gpg-")
    try:
        _gpg(["--import"], home, input=armored_key.encode(), timeout=60)
        result = _gpg(["--yes", "--trust-model", "always", "--recipient", fingerprint, "--output", str(dst), "--encrypt", str(src)], home, timeout=3600)
        if not dst.is_file() or dst.stat().st_size == 0:
            raise RuntimeError(f"PGP encryption failed: {result.stderr.decode(errors='replace').strip()[-300:]}")
    finally:
        shutil.rmtree(home, ignore_errors=True)


def _connect(database: str | None = None, **extra):
    return pymysql.connect(host=settings.TENANT_DB_HOST, port=settings.TENANT_DB_PORT, user=settings.TENANT_DB_USER,
                           password=settings.TENANT_DB_PASSWORD, database=database, charset="utf8mb4", connect_timeout=10, **extra)


def tenant_file_roots(tenant: Tenant) -> list[Path]:
    slug = tenant.slug
    roots = [Path(settings.UPLOAD_DIR) / slug, Path(settings.UPLOAD_DIR) / "tenant_settings" / slug, Path(settings.MEDIA_ROOT).resolve() / slug]
    seen, result = set(), []
    for root in roots:
        resolved = root.resolve()
        if resolved not in seen and resolved.is_dir():
            seen.add(resolved)
            result.append(resolved)
    return result


def _tables_for(db_name: str, components: list[str]) -> list[str]:
    connection = _connect(db_name)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")
            tables = [row[0] for row in cursor.fetchall()]
    finally:
        connection.close()
    if "database" in components:
        return tables
    return [t for t in tables if any(COMPONENT_TABLES[c].search(t) for c in components if c in COMPONENT_TABLES)]


def estimate(tenant: Tenant, components: list[str]) -> dict:
    tables = _tables_for(tenant.db_name, components) if any(c != "files" for c in components) else []
    db_bytes = 0
    if tables:
        connection = _connect()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COALESCE(SUM(data_length), 0) FROM information_schema.tables WHERE table_schema = %s AND table_name IN %s",
                    (tenant.db_name, tuple(tables)),
                )
                db_bytes = int(cursor.fetchone()[0])
        finally:
            connection.close()
    file_bytes = sum(f.stat().st_size for root in tenant_file_roots(tenant) for f in root.rglob("*") if f.is_file()) if "files" in components else 0
    return {"tables": len(tables), "database_bytes": db_bytes, "file_bytes": file_bytes, "total_bytes": db_bytes + file_bytes}


def _mask(column: str, value):
    if value is None or value == "":
        return value
    s = str(value)
    if "@" in s:
        local, _, domain = s.partition("@")
        return f"{local[:2]}***@{domain}"
    if re.search(r"(phone|mobile)", column, re.I):
        digits = re.sub(r"\D", "", s)
        return "*" * max(0, len(digits) - 4) + digits[-4:]
    return s[:1] + "***"


def _sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return str(int(value))
    if isinstance(value, (int, float, Decimal)):
        return str(value)
    if isinstance(value, (bytes, bytearray)):
        return "X'" + bytes(value).hex() + "'"
    if isinstance(value, (datetime, date)):
        return "'" + value.isoformat(sep=" ") + "'" if isinstance(value, datetime) else "'" + value.isoformat() + "'"
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n").replace("\r", "\\r") + "'"


def _json_value(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).hex()
    return value


def _plan_columns(columns: list[tuple[str, bool]], pii: str) -> dict[str, str]:
    """Per column: 'keep' | 'mask' | 'drop' (secret or excluded personal data)."""
    plan = {}
    for name, _nullable in columns:
        if SECRET_COLUMN.search(name):
            plan[name] = "drop"
        elif PII_COLUMN.search(name):
            plan[name] = {"Include": "keep", "Mask": "mask", "Exclude": "drop"}[pii]
        else:
            plan[name] = "keep"
    return plan


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def _export_key() -> bytes:
    return hashlib.sha256(("tenant-export:" + settings.SECRET_KEY).encode()).digest()


def _encrypt_file(src: Path, dst: Path) -> None:
    """AES-256-CTR with an HMAC-SHA256 tag (encrypt-then-MAC): [16-byte nonce][ciphertext][32-byte tag]."""
    key = _export_key()
    nonce = os.urandom(16)
    encryptor = Cipher(algorithms.AES(key), modes.CTR(nonce)).encryptor()
    mac = hmac.new(key, nonce, hashlib.sha256)
    with src.open("rb") as fin, dst.open("wb") as fout:
        fout.write(nonce)
        for block in iter(lambda: fin.read(_CHUNK), b""):
            chunk = encryptor.update(block)
            mac.update(chunk)
            fout.write(chunk)
        tail = encryptor.finalize()
        mac.update(tail)
        fout.write(tail)
        fout.write(mac.digest())


def decrypt_stream(path: Path):
    """Yield the decrypted package after verifying its HMAC tag."""
    key = _export_key()
    size = path.stat().st_size
    with path.open("rb") as handle:
        nonce = handle.read(16)
        body_len = size - 16 - 32
        mac = hmac.new(key, nonce, hashlib.sha256)
        remaining = body_len
        while remaining:
            block = handle.read(min(_CHUNK, remaining))
            mac.update(block)
            remaining -= len(block)
        if not hmac.compare_digest(mac.digest(), handle.read(32)):
            raise ValueError("Export package failed its integrity check")
        handle.seek(16)
        decryptor = Cipher(algorithms.AES(key), modes.CTR(nonce)).decryptor()
        remaining = body_len
        while remaining:
            block = handle.read(min(_CHUNK, remaining))
            remaining -= len(block)
            yield decryptor.update(block)
        yield decryptor.finalize()


def _set_job(job_id: int, **values) -> None:
    db = MasterSessionLocal()
    try:
        db.query(TenantExportJob).filter(TenantExportJob.id == job_id).update(values)
        db.commit()
    finally:
        db.close()


def _parquet_type(mysql_type: str):
    import pyarrow as pa
    t = mysql_type.lower()
    if re.match(r"(tiny|small|medium|big)?int\b|year|bit", t):
        return pa.int64()
    if re.match(r"(decimal|numeric|float|double|real)", t):
        return pa.float64()
    if t.startswith("datetime") or t.startswith("timestamp"):
        return pa.timestamp("us")
    if t == "date":
        return pa.date32()
    if re.match(r"(binary|varbinary|tinyblob|blob|mediumblob|longblob)", t):
        return pa.binary()
    return pa.string()


def _parquet_value(value, arrow_type):
    import pyarrow as pa
    if value is None:
        return None
    if arrow_type == pa.float64() and isinstance(value, Decimal):
        return float(value)
    if arrow_type == pa.int64() and isinstance(value, (bytes, bytearray)):
        return int.from_bytes(value, "big")
    if arrow_type == pa.string() and not isinstance(value, str):
        return _json_value(value) if not isinstance(value, (int, float)) else str(value)
    if arrow_type == pa.timestamp("us") and isinstance(value, date) and not isinstance(value, datetime):
        return datetime(value.year, value.month, value.day)
    return value


def _write_parquet(cursor, out_path: Path, names: list[str], types: dict[str, str], plan: dict[str, str]) -> int:
    """Stream a SELECT * cursor into a typed Parquet file in 20,000-row row groups; returns the row count."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    kept = [c for c in names if plan[c] != "drop"]
    arrow = {c: (pa.string() if plan[c] == "mask" else _parquet_type(types[c])) for c in kept}
    schema = pa.schema([(c, arrow[c]) for c in kept])
    rows, batch = 0, {c: [] for c in kept}
    with pq.ParquetWriter(out_path, schema, compression="snappy") as writer:
        def flush():
            if kept and batch[kept[0]]:
                writer.write_table(pa.table({c: pa.array(batch[c], type=arrow[c]) for c in kept}, schema=schema))
                for c in kept:
                    batch[c].clear()
        for row in cursor:
            for name, value in zip(names, row):
                action = plan[name]
                if action == "drop":
                    continue
                batch[name].append(_mask(name, value) if action == "mask" else _parquet_value(value, arrow[name]))
            rows += 1
            if rows % 20000 == 0:
                flush()
        flush()
    return rows


def _job_lock(job_id: int):
    """Hold a MariaDB advisory lock while the job runs: a 'running' job whose lock is free was interrupted."""
    connection = master_engine.connect()
    if connection.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": f"tenant_export_{job_id}"}).scalar() != 1:
        connection.close()
        return None
    return connection


def _lock_free(name: str) -> bool:
    with master_engine.connect() as connection:
        return connection.execute(text("SELECT IS_FREE_LOCK(:n)"), {"n": name}).scalar() == 1


def run_export(job_id: int) -> None:
    """Build the export package (background thread). Only one worker can run a job: it holds the job's lock."""
    lock = _job_lock(job_id)
    if lock is None:
        return
    try:
        _run_export(job_id)
    finally:  # pooled connections keep MariaDB session locks, so release explicitly
        lock.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": f"tenant_export_{job_id}"})
        lock.close()


def _run_export(job_id: int) -> None:
    db = MasterSessionLocal()
    job = db.get(TenantExportJob, job_id)
    tenant = db.get(Tenant, job.tenant_id)
    db.close()
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f"export-{job_id}-"))
    try:
        _set_job(job_id, status="running", progress=1)
        fmt = format_key(job.format)
        if fmt == "parquet" and option_status()["Parquet (analytics)"]:
            raise RuntimeError(option_status()["Parquet (analytics)"])
        components = list(job.components)
        tables = _tables_for(tenant.db_name, components) if any(c != "files" for c in components) else []
        files = [(root, f) for root in tenant_file_roots(tenant) for f in root.rglob("*") if f.is_file()] if "files" in components else []
        total_units = max(1, len(tables) + (1 if files else 0))
        manifest = {"tenant": tenant.name, "slug": tenant.slug, "database": tenant.db_name, "generated_at": datetime.now().isoformat(),
                    "components": [label for key, label in EXPORT_COMPONENTS if key in components], "format": job.format,
                    "personal_data": job.pii, "excluded_always": "credential columns (passwords, tokens, secrets)",
                    "tables": {}, "files": 0, "checksums": {}}
        package = work / "package.zip"
        connection = _connect(tenant.db_name, cursorclass=pymysql.cursors.SSCursor)
        try:
            with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
                sql_path = work / "database.sql" if fmt == "sql" else None
                sql_out = sql_path.open("w", encoding="utf-8", newline="\n") if sql_path else None
                if sql_out:
                    sql_out.write(f"-- MariaDB dump of {tenant.name} ({tenant.db_name}), exported {manifest['generated_at']}\n"
                                  f"-- Restore with: mysql <database> < database.sql\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n")
                for index, table in enumerate(tables, start=1):
                    validate_mysql_identifier(table, field_name="table name")
                    meta = _connect(tenant.db_name)
                    try:
                        with meta.cursor() as cursor:
                            cursor.execute(f"SHOW COLUMNS FROM `{table}`")
                            described = cursor.fetchall()
                            columns = [(row[0], row[2] == "YES") for row in described]
                            types = {row[0]: row[1] for row in described}
                            create_sql = None
                            if sql_out:
                                cursor.execute(f"SHOW CREATE TABLE `{table}`")
                                create_sql = cursor.fetchone()[1]
                    finally:
                        meta.close()
                    plan = _plan_columns(columns, job.pii)
                    nullable = dict(columns)
                    names = [c for c, _ in columns]
                    kept = [c for c in names if plan[c] != "drop"]
                    rows = 0
                    with connection.cursor() as cursor:
                        cursor.execute(f"SELECT * FROM `{table}`")
                        if fmt == "sql":
                            sql_out.write(f"\nDROP TABLE IF EXISTS `{table}`;\n{create_sql};\n")
                            column_list = ", ".join(f"`{c}`" for c in names)
                            for row in cursor:
                                values = []
                                for name, value in zip(names, row):
                                    action = plan[name]
                                    if action == "drop":
                                        value = None if nullable[name] else ""
                                    elif action == "mask":
                                        value = _mask(name, value)
                                    values.append(_sql_literal(value))
                                sql_out.write(f"INSERT INTO `{table}` ({column_list}) VALUES ({', '.join(values)});\n")
                                rows += 1
                        elif fmt == "parquet":
                            out_path = work / f"{table}.parquet"
                            rows = _write_parquet(cursor, out_path, names, types, plan)
                            arc = f"data/{table}.parquet"
                            manifest["checksums"][arc] = _sha256_file(out_path)
                            zf.write(out_path, arc)
                            out_path.unlink()
                        else:
                            out_path = work / f"{table}.{fmt}"
                            with out_path.open("w", encoding="utf-8", newline="") as out:
                                writer = csv.writer(out) if fmt == "csv" else None
                                if writer:
                                    writer.writerow(kept)
                                else:
                                    out.write("[\n")
                                for row in cursor:
                                    record = {}
                                    for name, value in zip(names, row):
                                        action = plan[name]
                                        if action == "drop":
                                            continue
                                        record[name] = _mask(name, value) if action == "mask" else value
                                    if writer:
                                        writer.writerow(["" if record[c] is None else _json_value(record[c]) for c in kept])
                                    else:
                                        out.write(("," if rows else "") + json.dumps({k: _json_value(v) for k, v in record.items()}, ensure_ascii=False) + "\n")
                                    rows += 1
                                if not writer:
                                    out.write("]\n")
                            arc = f"data/{table}.{fmt}"
                            manifest["checksums"][arc] = _sha256_file(out_path)
                            zf.write(out_path, arc)
                            out_path.unlink()
                    manifest["tables"][table] = rows
                    _set_job(job_id, progress=int(index / total_units * 90))
                if sql_out:
                    sql_out.write("\nSET FOREIGN_KEY_CHECKS=1;\n")
                    sql_out.close()
                    manifest["checksums"]["data/database.sql"] = _sha256_file(sql_path)
                    zf.write(sql_path, "data/database.sql")
                    sql_path.unlink()
                for index, (root, path) in enumerate(files, start=1):
                    arc = f"files/{root.name}/{path.relative_to(root).as_posix()}"
                    manifest["checksums"][arc] = _sha256_file(path)
                    zf.write(path, arc)
                    if index % 25 == 0:  # files: 90–96 %
                        _set_job(job_id, progress=90 + int(index / len(files) * 6))
                manifest["files"] = len(files)
                zf.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
        finally:
            connection.close()
        name = f"export-{job_id}-{uuid.uuid4().hex}.zip"
        _set_job(job_id, progress=97)  # checksum and encryption of the package
        package_sha = _sha256_file(package)
        options = dict(job.options or {})
        _set_job(job_id, progress=98)
        if job.encryption.startswith("AES"):
            name += ".enc"
            _encrypt_file(package, EXPORT_DIR / name)
        elif job.encryption == ENCRYPTIONS[1]:
            name += ".gpg"
            _pgp_encrypt(package, EXPORT_DIR / name, options.get("pgp_key", ""), options.get("pgp_fingerprint", ""))
        else:
            shutil.move(str(package), EXPORT_DIR / name)
        final = EXPORT_DIR / name
        options["file_sha256"] = _sha256_file(final)
        _set_job(job_id, status="ready", progress=100, file_name=name, size_bytes=final.stat().st_size, sha256=package_sha, options=options,
                 manifest={"tables": manifest["tables"], "files": manifest["files"], "rows": sum(manifest["tables"].values())}, completed_at=datetime.now())
        if delivery_of(job) == "Encrypted email":
            _email_link(job_id)
    except Exception as exc:
        logger.exception("Export job %s failed", job_id)
        _set_job(job_id, status="failed", error=str(exc)[:1000])
    finally:
        shutil.rmtree(work, ignore_errors=True)


def start_export(job_id: int) -> None:
    threading.Thread(target=run_export, args=(job_id,), daemon=True, name=f"tenant-export-{job_id}").start()


def retry_export(db, job: TenantExportJob) -> None:
    """Run a failed (or interrupted) export again from the start; its old file, if any, is removed."""
    if job.status not in ("failed", "expired") and not (job.status == "ready" and not file_available(job)):
        raise ValueError("Only failed or expired exports can be retried")
    if job.file_name:
        (EXPORT_DIR / job.file_name).unlink(missing_ok=True)
    options = dict(job.options or {})
    options["attempts"] = int(options.get("attempts", 1)) + 1
    job.status, job.progress, job.error, job.file_name, job.size_bytes, job.sha256, job.completed_at, job.options = "queued", 0, None, None, None, None, None, options
    db.flush()


def recover_and_expire() -> dict:
    """Housekeeping (every minute): mark exports whose worker died as failed, and remove packages past their link window."""
    db = MasterSessionLocal()
    interrupted = expired = 0
    try:
        stale = datetime.now() - timedelta(minutes=2)
        for job in db.query(TenantExportJob).filter(TenantExportJob.status.in_(("queued", "running"))).all():
            if (job.status == "running" or job.created_at < stale) and _lock_free(f"tenant_export_{job.id}"):
                db.refresh(job)
                if job.status in ("queued", "running"):
                    job.status, job.error = "failed", INTERRUPTED
                    interrupted += 1
        for job in db.query(TenantExportJob).filter(TenantExportJob.status == "ready").all():
            if not file_available(job):  # removed from storage outside the platform: nothing left to verify or download
                mark_missing(job)
                expired += 1
                continue
            if (job.options or {}).get("legal_hold"):   # Trust & Safety legal-hold packages are never removed automatically
                continue
            if (job.completed_at or job.created_at) + timedelta(days=job.link_days) < datetime.now():
                if job.file_name:
                    (EXPORT_DIR / job.file_name).unlink(missing_ok=True)
                job.status, job.file_name = "expired", None
                expired += 1
        db.commit()
    finally:
        db.close()
    return {"interrupted": interrupted, "expired": expired}


MISSING = "The package file is no longer in export storage – retry the export to rebuild it"


def file_available(job: TenantExportJob) -> bool:
    return job.status == "ready" and bool(job.file_name) and (EXPORT_DIR / job.file_name).is_file()


def mark_missing(job: TenantExportJob) -> None:
    """A ready export whose file is gone can't be verified or downloaded: expire it so it can be retried."""
    job.status, job.file_name, job.error = "expired", None, MISSING


def verify_export(job: TenantExportJob) -> dict:
    """Recompute the checksums of the stored file (and of the decrypted package for platform-key encryption)."""
    path = EXPORT_DIR / (job.file_name or "")
    if job.status != "ready" or not job.file_name or not path.is_file():
        raise ValueError("The export file is not available")
    stored = (job.options or {}).get("file_sha256")
    actual_file = _sha256_file(path)
    result = {"package_sha256": job.sha256, "file_sha256": actual_file, "file_ok": stored == actual_file if stored else None, "package_ok": None}
    if job.file_name.endswith(".enc"):
        digest = hashlib.sha256()
        try:
            for block in decrypt_stream(path):
                digest.update(block)
            result["package_ok"] = digest.hexdigest() == job.sha256
        except ValueError:
            result["package_ok"] = False
    elif not job.file_name.endswith(".gpg"):
        result["package_ok"] = actual_file == job.sha256
    result["verified"] = result["file_ok"] is not False and result["package_ok"] is not False
    return result


def download_token(job: TenantExportJob) -> tuple[str, datetime]:
    expires = (job.completed_at or datetime.now()) + timedelta(days=job.link_days)
    token = jwt.encode({"purpose": "tenant_export", "job": job.id, "exp": int(expires.timestamp())}, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    return token, expires


def job_from_token(token: str) -> int:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError as exc:
        raise ValueError("This download link is invalid or has expired") from exc
    if payload.get("purpose") != "tenant_export":
        raise ValueError("This download link is invalid")
    return int(payload["job"])


def download_url(job: TenantExportJob) -> tuple[str, datetime]:
    token, expires = download_token(job)
    return f"{(job.base_url or '').rstrip('/')}/api/v1/platform/exports/download?token={token}", expires


def _email_link(job_id: int) -> None:
    from app.services.tenant_onboarding import send_email
    db = MasterSessionLocal()
    try:
        job = db.get(TenantExportJob, job_id)
        tenant = db.get(Tenant, job.tenant_id)
        url, expires = download_url(job)
        text_body = (f"Hello {tenant.admin_name},\n\nThe data export of {tenant.name} is ready.\nDownload it here:\n\n{url}\n\n"
                     f"The link expires on {expires:%d %b %Y %H:%M}. Package SHA-256: {job.sha256}")
        html_body = (f"<p>Hello {tenant.admin_name},</p><p>The data export of <b>{tenant.name}</b> is ready.</p>"
                     f'<p><a href="{url}">Download the export</a></p><p>The link expires on {expires:%d %b %Y %H:%M}.<br>SHA-256: <code>{job.sha256}</code></p>')
        send_email(tenant, tenant.admin_email, f"{tenant.name} data export is ready", text_body, html_body)
    except Exception as exc:
        logger.exception("Export link email failed for job %s", job_id)
        job = db.get(TenantExportJob, job_id)
        job.error = f"Package ready, but the link email failed: {exc}"
        db.commit()
    finally:
        db.close()
