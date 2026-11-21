"""Environments & sandboxes (Data & infrastructure → Environments & sandboxes).

Sandboxes
    Each sandbox is its own MariaDB database next to the tenant's production database, named
    ``<tenant db>_sb_<8 hex>``, with its own MariaDB account that is granted rights on that database only. The platform
    reads production with read-committed, non-locking SELECTs to copy it; everything written afterwards (masking,
    change detection) goes through the sandbox account, so it cannot touch production. The production tenant record,
    its connection settings and its backups are never changed.
    Sources: Production (masked PII) – every table copied, then personal data masked and verified against production
    before the sandbox becomes Active; Production (full) – unmasked copy, only for Super admins and only while the
    tenant's "Mask personal data in sandboxes" control is off; Template data – configuration and master tables only;
    Empty – schema only. Login sessions, OTPs, device and push tokens are never copied.
    Provisioning runs in a background worker; a sandbox is Active only after its database is built and verified.
Change sets
    Only rows of supported configuration tables (single-column primary key, same columns in sandbox and production)
    can be promoted. When a sandbox is built, a fingerprint of each such row is stored (the baseline = production at
    that moment). Rows that differ from the baseline in the sandbox form the change set. Promotion locks the affected
    production rows, refuses rows that changed in production since the baseline, writes a verified rollback point
    (before-images + an SQL dump of the affected tables), then applies inserts / updates / deletes in one transaction.
    A whole sandbox database is never copied over production.
Policies (Control Center → Environments & sandboxes): sbOn, sbMax, sbDays, sbMask, sbPromote – enforced here.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Optional

import pymysql
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import case, func, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database import MasterSessionLocal, master_engine, validate_mysql_identifier
from app.models.platform_sandbox import PlatformSandbox, PlatformSandboxBaseline, PlatformSandboxChangeSet
from app.models.tenant import Tenant
from app.services import platform_controls as controls

logger = logging.getLogger(__name__)

SOURCES = {"masked": "Production (masked PII)", "full": "Production (full)", "template": "Template data", "empty": "Empty"}
LIVE = ("provisioning", "active", "refreshing", "failed")          # hold a database (or are building one)
COUNTED = ("provisioning", "active", "refreshing")                  # count against "Sandboxes per tenant"
OPEN_SETS = ("ready", "awaiting_approval", "promoting", "failed")   # "Pending change sets"
APPROVAL_ACTION = "promote_change_set"
EXTEND_DAYS = 30
MAX_DAYS = 365
STALE_MINUTES = 15                                                  # no heartbeat for this long = worker died
ROLLBACK_DIR = Path(os.environ.get("BACKUP_DIR", "./backups")).resolve() / "sandbox-rollback"

# Never copied into any sandbox: live credentials and sessions of production users.
NEVER_COPY = ("user_sessions", "login_otp_challenges", "trusted_devices", "quick_pin_credentials", "user_push_tokens")
# Configuration that can be promoted to production (each also needs a single-column primary key in both databases).
PROMOTABLE = (
    "settings", "tenant_settings", "modules", "form_fields", "roles", "role_permissions", "notification_rules",
    "notification_templates", "notification_event_definitions", "letter_templates", "letter_types", "lead_sources",
    "lead_categories", "lead_sub_categories", "vertical_sectors", "vertical_sub_sectors", "products_master",
    "business_categories", "business_category_units", "business_units", "regions", "states", "districts",
    "location_masters", "report_types", "report_type_fields", "approval_rules", "questionnaires",
    "questionnaire_structure", "questionnaire_form_elements",
)
# Template data = configuration and masters (the promotable tables plus their non-promotable companions).
TEMPLATE = PROMOTABLE + ("permissions", "approval_rule_steps", "approval_escalation_rules", "approval_escalation_settings",
                         "approval_auto_approve_settings", "report_folders")

# Personal-data masking: column-name rules applied to every copied table except the promotable configuration.
_MASK_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"(^|_)(hashed_password|org_password|password|otp_hash|refresh_token_hash|token|fcm_token|secret|api_key)$", re.I), "secret"),
    (re.compile(r"(^|_)e?mail(_id)?$|email", re.I), "email"),
    (re.compile(r"phone|mobile|whatsapp|(^|_)fax$", re.I), "phone"),
    (re.compile(r"^(first_name|last_name|full_name|middle_name|contact_person|person_name|contact_name)$", re.I), "name"),
    (re.compile(r"(^|_)(pan_no|pan_number|aadhaar|aadhar|aadhaar_no|passport(_no)?|gst_no|gst_number|gstin|account_no|ifsc_code|ifsc)$|_account_no$|_ifsc_code$", re.I), "idnum"),
    (re.compile(r"(^|_)(dob|date_of_birth)$", re.I), "null"),
    (re.compile(r"^ip_address$", re.I), "ip"),
    (re.compile(r"address(_text|_override)?$|street|(^|_)(pincode|pin_code|zip|zip_code|postal_code)$", re.I), "address"),
]
_STRING_TYPES = ("char", "varchar", "text", "tinytext", "mediumtext", "longtext")
_DATE_TYPES = ("date", "datetime", "timestamp")

_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="sandbox")
_lock = threading.Lock()
_ready = {"schema": False}


class SandboxError(Exception):
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def ensure_schema() -> None:
    if not _ready["schema"]:
        for model in (PlatformSandbox, PlatformSandboxBaseline, PlatformSandboxChangeSet):
            model.__table__.create(bind=master_engine, checkfirst=True)
        _ready["schema"] = True


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _utc(value: Optional[datetime]) -> Optional[str]:
    return f"{value.replace(microsecond=0).isoformat()}Z" if value else None


def code(cs: PlatformSandboxChangeSet) -> str:
    return f"CS-{cs.id}"


def _key() -> bytes:
    return hashlib.sha256(("platform-sandbox:" + settings.SECRET_KEY).encode()).digest()


def _encrypt(secret: str) -> str:
    nonce = os.urandom(12)
    return base64.b64encode(nonce + AESGCM(_key()).encrypt(nonce, secret.encode(), b"sandbox")).decode()


def _decrypt(blob: str) -> str:
    raw = base64.b64decode(blob)
    return AESGCM(_key()).decrypt(raw[:12], raw[12:], b"sandbox").decode()


def _q(name: str) -> str:
    return "`" + validate_mysql_identifier(name, field_name="identifier") + "`"


def _admin(database: Optional[str] = None, **extra):
    return pymysql.connect(host=settings.TENANT_DB_HOST, port=settings.TENANT_DB_PORT, user=settings.TENANT_DB_USER,
                           password=settings.TENANT_DB_PASSWORD, database=database, charset="utf8mb4", connect_timeout=10, **extra)


def _user_host() -> str:
    return "localhost" if settings.TENANT_DB_HOST in ("localhost", "127.0.0.1", "::1") else "%"


def sandbox_db_name(prod_db: str) -> str:
    return validate_mysql_identifier(f"{prod_db}_sb_{secrets.token_hex(4)}", field_name="database name")


def _guard(sb: PlatformSandbox, tenant: Tenant) -> None:
    """A sandbox database name must be its tenant's ``<prod>_sb_<8 hex>`` and never the production database."""
    if sb.db_name == tenant.db_name or not re.fullmatch(re.escape(tenant.db_name) + r"_sb_[0-9a-f]{8}", sb.db_name or ""):
        raise SandboxError(f"Refusing to use “{sb.db_name}”: it is not a sandbox database of {tenant.name}", 409)


def _sandbox_conn(sb: PlatformSandbox, tenant: Tenant):
    """Connection as the sandbox's own MariaDB account, checked to be inside the sandbox database."""
    _guard(sb, tenant)
    if not sb.db_user or not sb.db_password:
        raise SandboxError("This sandbox has no database account", 409)
    conn = pymysql.connect(host=settings.TENANT_DB_HOST, port=settings.TENANT_DB_PORT, user=sb.db_user, password=_decrypt(sb.db_password),
                           database=sb.db_name, charset="utf8mb4", connect_timeout=10, autocommit=False)
    with conn.cursor() as c:
        c.execute("SELECT DATABASE()")
        if c.fetchone()[0] != sb.db_name:
            conn.close()
            raise SandboxError("Sandbox connection is not on the sandbox database", 500)
    return conn


def _tables(cursor, schema: str) -> list[str]:
    cursor.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = %s AND table_type = 'BASE TABLE' ORDER BY table_name", (schema,))
    return [r[0] for r in cursor.fetchall()]


def _columns(cursor, schema: str, tables: Optional[list[str]] = None) -> dict[str, list[tuple[str, str, str, int, bool, bool]]]:
    """{table: [(name, data_type, column_type, max_len, nullable, generated)]} for a schema in one query."""
    sql = ("SELECT table_name, column_name, data_type, column_type, COALESCE(character_maximum_length, 0), is_nullable = 'YES', "
           "extra LIKE '%%GENERATED%%' FROM information_schema.columns WHERE table_schema = %s")
    params: list[Any] = [schema]
    if tables is not None:
        if not tables:
            return {}
        sql += " AND table_name IN (" + ", ".join(["%s"] * len(tables)) + ")"
        params += tables
    cursor.execute(sql + " ORDER BY table_name, ordinal_position", params)
    out: dict[str, list] = {}
    for t, name, dtype, ctype, maxlen, nullable, generated in cursor.fetchall():
        out.setdefault(t, []).append((name, dtype.lower(), ctype.lower(), int(maxlen or 0), bool(nullable), bool(generated)))
    return out


def _single_pks(cursor, schema: str) -> dict[str, str]:
    cursor.execute("SELECT table_name, MIN(column_name), COUNT(*) FROM information_schema.key_column_usage "
                   "WHERE table_schema = %s AND constraint_name = 'PRIMARY' GROUP BY table_name", (schema,))
    return {t: col for t, col, n in cursor.fetchall() if n == 1}


def sizes_mb(db_names: list[str]) -> dict[str, float]:
    """Storage of many sandbox databases in one grouped information_schema query."""
    if not db_names:
        return {}
    conn = _admin()
    try:
        with conn.cursor() as c:
            c.execute("SELECT table_schema, ROUND(SUM(data_length + index_length) / 1048576, 2) FROM information_schema.tables "
                      "WHERE table_schema IN (" + ", ".join(["%s"] * len(db_names)) + ") GROUP BY table_schema", db_names)
            return {s: float(v or 0) for s, v in c.fetchall()}
    finally:
        conn.close()


# ─── Policies ────────────────────────────────────────────────────────────────

def policy(db: Session, tenant_id: int) -> dict:
    return {"enabled": bool(controls.value(db, "sbOn", tenant_id)), "max": int(controls.value(db, "sbMax", tenant_id)),
            "days": int(controls.value(db, "sbDays", tenant_id)), "mask": bool(controls.value(db, "sbMask", tenant_id)),
            "approval": bool(controls.value(db, "sbPromote", tenant_id))}


# ─── Masking ─────────────────────────────────────────────────────────────────

def _mask_plan(columns: dict[str, list], skip: set[str]) -> list[tuple[str, str, str, int, bool, str]]:
    """(table, column, rule, max_len, nullable, data_type) for every column holding personal data."""
    plan = []
    for table, cols in columns.items():
        if table in skip:
            continue
        for name, dtype, _ctype, maxlen, nullable, generated in cols:
            if generated or name.endswith("_id") or name.endswith("_at") and dtype not in _DATE_TYPES:
                continue
            for pattern, rule in _MASK_RULES:
                if pattern.search(name):
                    if rule == "null" and not (dtype in _DATE_TYPES or dtype in _STRING_TYPES):
                        break
                    if rule != "null" and dtype not in _STRING_TYPES:
                        break   # booleans / counters such as email_sent, must_change_password, *_at timestamps
                    plan.append((table, name, rule, maxlen, nullable, dtype))
                    break
    return plan


def _mask_expr(col: str, rule: str, maxlen: int, nullable: bool, table: str) -> str:
    c = _q(col)
    digest = f"SHA2(CONCAT('{secrets.token_hex(8)}', {c}), 256)"   # salted: masked values can't be looked up
    exprs = {
        "email": f"CONCAT('masked-', LEFT({digest}, 12), '@example.invalid')",
        "phone": f"CONCAT('+00', LPAD(MOD(CRC32({digest}), 100000000), 8, '0'))",
        "name": f"CONCAT('Person ', UPPER(LEFT({digest}, 6)))",
        "idnum": f"CONCAT('X', UPPER(LEFT({digest}, 9)))",
        "address": "'Masked'" if "pin" not in col.lower() and "zip" not in col.lower() and "postal" not in col.lower() else "'000000'",
        "ip": "'0.0.0.0'",
        "secret": "NULL" if nullable else "'!sandbox-disabled'",
        "null": "NULL" if nullable else "'1900-01-01'",
    }
    expr = exprs[rule]
    if rule in ("email", "phone", "name", "idnum") and maxlen:
        expr = f"LEFT({expr}, {maxlen})"
    if table == "users" and col == "hashed_password":
        expr = "'!sandbox-disabled'"  # nobody can sign in with a production password
    return expr


def _apply_masking(conn, columns: dict[str, list], skip: set[str]) -> list[tuple]:
    plan = _mask_plan(columns, skip)
    with conn.cursor() as c:
        c.execute("SET FOREIGN_KEY_CHECKS = 0")
        for table, col, rule, maxlen, nullable, _dtype in plan:
            c.execute(f"UPDATE {_q(table)} SET {_q(col)} = {_mask_expr(col, rule, maxlen, nullable, table)} "
                      f"WHERE {_q(col)} IS NOT NULL AND {_q(col)} <> ''")
        if "users" in columns and any(col == "username" for col, *_ in columns["users"]):
            c.execute("UPDATE `users` SET `username` = CONCAT('user', `id`)")
        c.execute("SET FOREIGN_KEY_CHECKS = 1")
    conn.commit()
    return plan


def _verify_masking(sb_db: str, prod_db: str, plan: list[tuple], pks: dict[str, str]) -> list[str]:
    """Columns where a sandbox value still equals the production value (should be none). Read-only, admin account."""
    leaks = []
    conn = _admin(read_timeout=600)
    try:
        with conn.cursor() as c:
            c.execute("SET SESSION TRANSACTION READ ONLY")
            for table, col, rule, *_ in plan:
                if rule == "secret" and table != "users":
                    continue
                s, p, qc = f"{_q(sb_db)}.{_q(table)}", f"{_q(prod_db)}.{_q(table)}", _q(col)
                pk = pks.get(table)
                if pk:
                    c.execute(f"SELECT COUNT(*) FROM {s} sx JOIN {p} px ON sx.{_q(pk)} = px.{_q(pk)} "
                              f"WHERE sx.{qc} = px.{qc} AND sx.{qc} IS NOT NULL AND sx.{qc} <> '' AND sx.{qc} NOT IN ('Masked', '000000', '0.0.0.0', '!sandbox-disabled')")
                else:
                    c.execute(f"SELECT COUNT(*) FROM {s} sx WHERE sx.{qc} IS NOT NULL AND sx.{qc} <> '' AND sx.{qc} NOT IN ('Masked', '000000', '0.0.0.0', '!sandbox-disabled') "
                              f"AND EXISTS (SELECT 1 FROM {p} px WHERE px.{qc} = sx.{qc})")
                if c.fetchone()[0]:
                    leaks.append(f"{table}.{col}")
            if "users" in pks:
                c.execute(f"SELECT COUNT(*) FROM {_q(sb_db)}.`users` sx JOIN {_q(prod_db)}.`users` px ON sx.id = px.id WHERE sx.username = px.username AND sx.username NOT LIKE 'user%%'")
                if c.fetchone()[0]:
                    leaks.append("users.username")
    finally:
        conn.close()
    return leaks


# ─── Fingerprints & change detection ─────────────────────────────────────────

def _hash_sql(table: str, pk: str, cols: list[str], where: str = "") -> str:
    parts = ", ".join(f"COALESCE(HEX(CAST({_q(c)} AS BINARY)), '~')" for c in cols)
    return f"SELECT CAST({_q(pk)} AS CHAR), MD5(CONCAT_WS(0x1f, {parts})) FROM {_q(table)}{where}"


def _promotable(cursor, schema: str) -> dict[str, tuple[str, list[str], list[tuple]]]:
    """{table: (pk, [hashable columns], column signature)} for supported configuration tables in a schema."""
    tables = [t for t in _tables(cursor, schema) if t in PROMOTABLE]
    pks = _single_pks(cursor, schema)
    cols = _columns(cursor, schema, tables)
    out = {}
    for t in tables:
        if t in pks and t in cols:
            plain = [c for c in cols[t] if not c[5]]
            out[t] = (pks[t], [c[0] for c in plain], [(c[0], c[2]) for c in plain])
    return out


def _fingerprints(cursor, tables: dict[str, tuple]) -> dict[str, dict[str, str]]:
    out = {}
    for t, (pk, cols, _sig) in tables.items():
        cursor.execute(_hash_sql(t, pk, cols))
        out[t] = {str(k): h for k, h in cursor.fetchall()}
    return out


def _store_baseline(sb: PlatformSandbox, tenant: Tenant) -> int:
    conn = _sandbox_conn(sb, tenant)
    try:
        with conn.cursor() as c:
            prints = _fingerprints(c, _promotable(c, sb.db_name))
    finally:
        conn.close()
    rows = [{"sandbox_id": sb.id, "table_name": t, "pk": pk, "row_hash": h} for t, m in prints.items() for pk, h in m.items()]
    with master_engine.begin() as conn:
        conn.execute(PlatformSandboxBaseline.__table__.delete().where(PlatformSandboxBaseline.sandbox_id == sb.id))
        for i in range(0, len(rows), 1000):
            conn.execute(PlatformSandboxBaseline.__table__.insert(), rows[i:i + 1000])
    return len(rows)


def _diff(db: Session, sb: PlatformSandbox, tenant: Tenant) -> dict[str, dict]:
    """Rows of promotable tables that differ in the sandbox from the baseline."""
    conn = _sandbox_conn(sb, tenant)
    try:
        with conn.cursor() as c:
            meta = _promotable(c, sb.db_name)
            current = _fingerprints(c, meta)
    finally:
        conn.close()
    base: dict[str, dict[str, str]] = {}
    for t, pk, h in db.query(PlatformSandboxBaseline.table_name, PlatformSandboxBaseline.pk, PlatformSandboxBaseline.row_hash).filter(
            PlatformSandboxBaseline.sandbox_id == sb.id):
        base.setdefault(t, {})[pk] = h
    details = {}
    for t, (pk_col, _cols, sig) in meta.items():
        now, was = current.get(t, {}), base.get(t, {})
        added = sorted(k for k in now if k not in was)
        removed = sorted(k for k in was if k not in now)
        changed = sorted(k for k in now if k in was and now[k] != was[k])
        if added or removed or changed:
            details[t] = {"pk": pk_col, "added": added, "changed": changed, "removed": removed, "signature": sig,
                          "base": {k: was[k] for k in changed + removed}, "new": {k: now[k] for k in added + changed}}
    return details


def _describe(details: dict) -> tuple[str, int]:
    parts, items = [], 0
    for t, d in sorted(details.items()):
        n = len(d["added"]) + len(d["changed"]) + len(d["removed"])
        items += n
        bits = [f"{len(d[k])} {label}" for k, label in (("added", "added"), ("changed", "changed"), ("removed", "removed")) if d[k]]
        parts.append(f"{t.replace('_', ' ')}: {', '.join(bits)}")
    text_ = "; ".join(parts)
    return (text_[:497] + "…") if len(text_) > 498 else text_, items


def scan(db: Session, sb: PlatformSandbox, tenant: Tenant) -> Optional[PlatformSandboxChangeSet]:
    """Refresh the sandbox's open change set from its current differences (no-op while one awaits approval)."""
    if sb.status != "active":
        return None
    open_set = (db.query(PlatformSandboxChangeSet).filter(PlatformSandboxChangeSet.sandbox_id == sb.id,
                                                          PlatformSandboxChangeSet.status.in_(OPEN_SETS))
                .order_by(PlatformSandboxChangeSet.id.desc()).first())
    if open_set and open_set.status in ("awaiting_approval", "promoting"):
        return open_set
    details = _diff(db, sb, tenant)
    if not details:
        if open_set:
            db.delete(open_set)
        return None
    contents, items = _describe(details)
    if open_set is None:
        open_set = PlatformSandboxChangeSet(tenant_id=tenant.id, sandbox_id=sb.id, sandbox_name=sb.name, status="ready")
        db.add(open_set)
    if open_set.details != details:
        open_set.details, open_set.contents, open_set.items, open_set.updated_at = details, contents, items, datetime.utcnow()
        if open_set.status == "failed":
            open_set.status, open_set.error = "ready", None
    db.flush()
    return open_set


# ─── Provisioning ────────────────────────────────────────────────────────────

def _beat(sandbox_id: int, progress: Optional[str] = None, **fields) -> None:
    values = {"heartbeat_at": datetime.utcnow(), **fields}
    if progress is not None:
        values["progress"] = progress[:200]
    with master_engine.begin() as conn:
        conn.execute(PlatformSandbox.__table__.update().where(PlatformSandbox.id == sandbox_id).values(**values))


def _drop(db_name: str, db_user: Optional[str], prod_db: str) -> None:
    """Drop a sandbox database and account. Refuses anything that is not ``<production db>_sb_<8 hex>``."""
    if not prod_db or db_name == prod_db or not re.fullmatch(re.escape(prod_db) + r"_sb_[0-9a-f]{8}", db_name or ""):
        raise SandboxError(f"Refusing to drop “{db_name}”: not a sandbox of {prod_db}", 409)
    conn = _admin(autocommit=True)
    try:
        with conn.cursor() as c:
            c.execute(f"DROP DATABASE IF EXISTS {_q(db_name)}")
            if db_user and re.fullmatch(r"sb_[0-9a-f]{8,12}", db_user):
                c.execute(f"DROP USER IF EXISTS '{db_user}'@'{_user_host()}'")
    finally:
        conn.close()


def _build(sandbox_id: int, db_name: str, db_user: str, password: str, source: str) -> tuple[float, Optional[datetime]]:
    """Create ``db_name`` from the tenant's production database. Raises on any failure (caller cleans up)."""
    session = MasterSessionLocal()
    try:
        sb = session.get(PlatformSandbox, sandbox_id)
        tenant = session.get(Tenant, sb.tenant_id)
        prod = validate_mysql_identifier(tenant.db_name, field_name="database name")
    finally:
        session.close()
    if db_name == prod:
        raise SandboxError("Sandbox and production database names are equal", 500)
    admin = _admin(autocommit=True, read_timeout=3600, write_timeout=3600)
    try:
        with admin.cursor() as c:
            c.execute("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED")   # non-locking reads of production
            c.execute(f"CREATE DATABASE {_q(db_name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
            c.execute(f"CREATE USER '{db_user}'@'{_user_host()}' IDENTIFIED BY %s", (password,))
            c.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, CREATE TEMPORARY TABLES, LOCK TABLES, "
                      f"CREATE VIEW, SHOW VIEW, TRIGGER, REFERENCES ON {_q(db_name)}.* TO '{db_user}'@'{_user_host()}'")
            tables = _tables(c, prod)
            columns = _columns(c, prod)
            c.execute("SET FOREIGN_KEY_CHECKS = 0")
            for i, t in enumerate(tables):
                c.execute(f"CREATE TABLE {_q(db_name)}.{_q(t)} LIKE {_q(prod)}.{_q(t)}")
                copy = source in ("masked", "full") or (source == "template" and t in TEMPLATE)
                if copy and t not in NEVER_COPY:
                    cols = ", ".join(_q(col[0]) for col in columns.get(t, []) if not col[5])
                    c.execute(f"INSERT INTO {_q(db_name)}.{_q(t)} ({cols}) SELECT {cols} FROM {_q(prod)}.{_q(t)}")
                if i % 10 == 0:
                    _beat(sandbox_id, f"Copying tables ({i + 1} of {len(tables)})")
            c.execute("SET FOREIGN_KEY_CHECKS = 1")
            pks = _single_pks(c, prod)
    finally:
        admin.close()
    verified_at = None
    if source == "masked":
        _beat(sandbox_id, "Masking personal data")
        sbconn = pymysql.connect(host=settings.TENANT_DB_HOST, port=settings.TENANT_DB_PORT, user=db_user, password=password,
                                 database=db_name, charset="utf8mb4", connect_timeout=10, read_timeout=3600)
        try:
            plan = _apply_masking(sbconn, {t: v for t, v in columns.items() if t in tables}, set(PROMOTABLE) | set(NEVER_COPY))
        finally:
            sbconn.close()
        _beat(sandbox_id, "Verifying masking against production")
        leaks = _verify_masking(db_name, prod, plan, pks)
        if leaks:
            raise SandboxError(f"Masking verification failed – production values remain in {', '.join(leaks[:8])}", 500)
        verified_at = datetime.utcnow()
    return sizes_mb([db_name]).get(db_name, 0.0), verified_at


def _run(sandbox_id: int, refresh: bool) -> None:
    """Background worker: build a (new) sandbox database; swap it in only after it succeeded."""
    session = MasterSessionLocal()
    try:
        sb = session.get(PlatformSandbox, sandbox_id)
        tenant = session.get(Tenant, sb.tenant_id)
        old_db, old_user, prod_db = sb.db_name, sb.db_user, tenant.db_name
        new_db = sandbox_db_name(tenant.db_name) if refresh else sb.db_name
        new_user = f"sb_{secrets.token_hex(5)}" if refresh else sb.db_user
        password = secrets.token_urlsafe(24) if refresh else _decrypt(sb.db_password)
        source = sb.source
    finally:
        session.close()
    try:
        size, verified = _build(sandbox_id, new_db, new_user, password, source)
        session = MasterSessionLocal()
        try:
            sb = session.get(PlatformSandbox, sandbox_id)
            tenant = session.get(Tenant, sb.tenant_id)
            if sb.status in ("deleted", "expired"):
                raise SandboxError("Sandbox was removed while it was being built", 409)
            if refresh:
                sb.db_name, sb.db_user, sb.db_password, sb.refreshed_at = new_db, new_user, _encrypt(password), datetime.utcnow()
                for cs in session.query(PlatformSandboxChangeSet).filter(PlatformSandboxChangeSet.sandbox_id == sb.id,
                                                                          PlatformSandboxChangeSet.status.in_(("ready", "failed"))):
                    cs.status, cs.updated_at = "superseded", datetime.utcnow()
            session.commit()
            _store_baseline(sb, tenant)
            sb.size_mb, sb.masking_verified_at = size, verified
            sb.status, sb.progress, sb.error, sb.heartbeat_at = "active", None, None, datetime.utcnow()
            sb.ready_at = sb.ready_at or datetime.utcnow()
            _audit_system(session, sb, tenant, "sandbox_refreshed" if refresh else "sandbox_ready",
                          f"Sandbox '{sb.name}' {'refreshed' if refresh else 'ready'}: {sb.db_name} ({SOURCES[sb.source]}, {size:.2f} MB"
                          + (", masking verified" if verified else "") + ")")
            session.commit()
        finally:
            session.close()
        if refresh and old_db != new_db:
            try:
                _drop(old_db, old_user, prod_db)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Old sandbox database %s not dropped: %s", old_db, exc)
    except Exception as exc:  # noqa: BLE001 - recorded on the sandbox and shown to staff
        logger.exception("Sandbox %s provisioning failed", sandbox_id)
        session = MasterSessionLocal()
        try:
            sb = session.get(PlatformSandbox, sandbox_id)
            tenant = session.get(Tenant, sb.tenant_id)
            try:
                _drop(new_db, new_user, prod_db)
            except Exception:  # noqa: BLE001
                logger.warning("Could not clean up %s", new_db)
            if refresh and sb.status == "refreshing":
                sb.status, sb.error = "active", f"Refresh failed – the previous copy is still in use: {exc}"[:2000]
            elif sb.status not in ("deleted", "expired"):
                sb.status, sb.error = "failed", str(exc)[:2000]
            sb.progress = None
            _audit_system(session, sb, tenant, "sandbox_failed", f"Sandbox '{sb.name}' {'refresh' if refresh else 'provisioning'} failed: {str(exc)[:300]}")
            session.commit()
        finally:
            session.close()


def _audit_system(db: Session, sb: PlatformSandbox, tenant: Tenant, action: str, description: str) -> None:
    from app.routers.platform_router import _write_platform_audit
    _write_platform_audit(db, None, action, "sandbox", sb.id, sb.name, f"{tenant.name}: {description}", "system",
                          new_data={"tenant_id": tenant.id, "db": sb.db_name, "status": sb.status})


def create(db: Session, admin, is_super: bool, tenant_id: int, name: str, source: str, days: Any, confirm_unmasked: bool) -> PlatformSandbox:
    ensure_schema()
    tenant = db.get(Tenant, tenant_id)
    if tenant is None:
        raise SandboxError("Tenant not found", 404)
    if tenant.status in ("suspended", "cancelled") or tenant.deletion_scheduled_at:
        raise SandboxError(f"{tenant.name} is {tenant.status if not tenant.deletion_scheduled_at else 'scheduled for deletion'} – sandboxes can't be created", 409)
    name = " ".join((name or "").split())
    if not name:
        raise SandboxError("Name the sandbox")
    if len(name) > 120:
        raise SandboxError("The name can be at most 120 characters")
    if source not in SOURCES:
        raise SandboxError("Choose where to copy data from")
    try:
        days_n = int(days)
    except (TypeError, ValueError):
        raise SandboxError("Expires in must be a whole number of days")
    if not 1 <= days_n <= MAX_DAYS:
        raise SandboxError(f"Expires in must be between 1 and {MAX_DAYS} days")
    rules = policy(db, tenant.id)
    if not rules["enabled"]:
        raise SandboxError(f"Sandboxes are turned off for {tenant.name} (Control Center → Environments & sandboxes)", 403)
    if source == "full":
        if rules["mask"]:
            raise SandboxError("“Mask personal data in sandboxes” is on for this tenant – choose Production (masked PII)", 403)
        if not is_super:
            raise SandboxError("Only a Super admin can create an unmasked production copy", 403)
        if not confirm_unmasked:
            raise SandboxError("Confirm that an unmasked copy of production personal data is authorised", 428)
    with _lock:
        used = db.query(func.count(PlatformSandbox.id)).filter(PlatformSandbox.tenant_id == tenant.id, PlatformSandbox.status.in_(COUNTED)).scalar()
        if used >= rules["max"]:
            raise SandboxError(f"{tenant.name} already has {used} sandbox(es) – the limit is {rules['max']} (Control Center)", 409)
        if db.query(PlatformSandbox.id).filter(PlatformSandbox.tenant_id == tenant.id, PlatformSandbox.status.in_(LIVE), PlatformSandbox.name == name).first():
            raise SandboxError(f"{tenant.name} already has a sandbox named “{name}”", 409)
        password = secrets.token_urlsafe(24)
        sb = PlatformSandbox(tenant_id=tenant.id, name=name, source=source, db_name=sandbox_db_name(tenant.db_name), db_user=f"sb_{secrets.token_hex(5)}",
                             db_password=_encrypt(password), status="provisioning", progress="Queued", created_by_id=admin.id if admin else None,
                             created_by=(admin.full_name or admin.username) if admin else None, created_at=datetime.utcnow(),
                             expires_at=datetime.utcnow() + timedelta(days=days_n), heartbeat_at=datetime.utcnow())
        db.add(sb)
        db.flush()
    return sb


def start(sandbox_id: int, refresh: bool = False) -> None:
    """Queue the build after the creating transaction has committed."""
    _pool.submit(_run, sandbox_id, refresh)


def refresh(db: Session, sb: PlatformSandbox) -> None:
    tenant = db.get(Tenant, sb.tenant_id)
    if sb.status != "active":
        raise SandboxError(f"Only an active sandbox can be refreshed (this one is {sb.status})", 409)
    if not policy(db, tenant.id)["enabled"]:
        raise SandboxError(f"Sandboxes are turned off for {tenant.name}", 403)
    if sb.source == "full" and policy(db, tenant.id)["mask"]:
        raise SandboxError("Unmasked copies are no longer allowed for this tenant – delete it and create a masked sandbox", 403)
    if db.query(PlatformSandboxChangeSet.id).filter(PlatformSandboxChangeSet.sandbox_id == sb.id,
                                                    PlatformSandboxChangeSet.status.in_(("awaiting_approval", "promoting"))).first():
        raise SandboxError("A change set from this sandbox is waiting for approval or being promoted", 409)
    sb.status, sb.progress, sb.error, sb.heartbeat_at = "refreshing", "Queued", None, datetime.utcnow()


def extend(sb: PlatformSandbox) -> datetime:
    if sb.status not in ("active", "provisioning", "refreshing", "failed"):
        raise SandboxError(f"This sandbox is {sb.status}", 409)
    new = max(sb.expires_at, datetime.utcnow()) + timedelta(days=EXTEND_DAYS)
    if new > datetime.utcnow() + timedelta(days=MAX_DAYS):
        raise SandboxError(f"A sandbox can't be kept for more than {MAX_DAYS} days ahead", 409)
    sb.expires_at = new
    return new


def remove(db: Session, sb: PlatformSandbox, status: str = "deleted") -> None:
    tenant = db.get(Tenant, sb.tenant_id)
    if sb.status in ("deleted", "expired"):
        raise SandboxError("This sandbox has already been removed", 409)
    if sb.status in ("provisioning", "refreshing") and sb.heartbeat_at and sb.heartbeat_at > datetime.utcnow() - timedelta(minutes=STALE_MINUTES):
        raise SandboxError("The sandbox is still being built – wait until it is ready or failed", 409)
    if db.query(PlatformSandboxChangeSet.id).filter(PlatformSandboxChangeSet.sandbox_id == sb.id,
                                                    PlatformSandboxChangeSet.status.in_(("awaiting_approval", "promoting"))).first():
        raise SandboxError("A change set from this sandbox is waiting for approval or being promoted", 409)
    _drop(sb.db_name, sb.db_user, tenant.db_name)
    for cs in db.query(PlatformSandboxChangeSet).filter(PlatformSandboxChangeSet.sandbox_id == sb.id, PlatformSandboxChangeSet.status.in_(("ready", "failed"))):
        cs.status, cs.updated_at = "superseded", datetime.utcnow()
    db.query(PlatformSandboxBaseline).filter(PlatformSandboxBaseline.sandbox_id == sb.id).delete(synchronize_session=False)
    sb.status, sb.deleted_at, sb.db_password, sb.progress, sb.size_mb = status, datetime.utcnow(), None, None, 0


def housekeeping() -> dict:
    """Scheduled: drop expired sandboxes, fail builds whose worker died, refresh change sets of active sandboxes."""
    ensure_schema()
    db = MasterSessionLocal()
    expired = stale = scanned = 0
    try:
        now = datetime.utcnow()
        for sb in db.query(PlatformSandbox).filter(PlatformSandbox.status.in_(("provisioning", "refreshing")),
                                                   PlatformSandbox.heartbeat_at < now - timedelta(minutes=STALE_MINUTES)).all():
            tenant = db.get(Tenant, sb.tenant_id)
            if sb.status == "provisioning":
                try:
                    _drop(sb.db_name, sb.db_user, tenant.db_name)
                except Exception:  # noqa: BLE001
                    pass
                sb.status = "failed"
            else:
                sb.status = "active"
            sb.error, sb.progress = "The build stopped (server restarted or worker died) – try again", None
            stale += 1
        db.commit()
        for sb in db.query(PlatformSandbox).filter(PlatformSandbox.status.in_(("active", "failed")), PlatformSandbox.expires_at < now).all():
            tenant = db.get(Tenant, sb.tenant_id)
            try:
                remove(db, sb, status="expired")
                _audit_system(db, sb, tenant, "sandbox_expired", f"Sandbox '{sb.name}' expired – database {sb.db_name} dropped")
                db.commit()
                expired += 1
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                logger.warning("Expired sandbox %s not removed: %s", sb.id, exc)
        actives = db.query(PlatformSandbox).filter(PlatformSandbox.status == "active").all()
        tenants = {t.id: t for t in db.query(Tenant).filter(Tenant.id.in_({s.tenant_id for s in actives} or {0})).all()}
        for sb in actives:
            try:
                scan(db, sb, tenants[sb.tenant_id])
                db.commit()
                scanned += 1
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                logger.warning("Change detection for sandbox %s failed: %s", sb.id, exc)
        if actives:
            sizes = sizes_mb([s.db_name for s in actives])
            for sb in actives:
                if sb.db_name in sizes:
                    sb.size_mb = sizes[sb.db_name]
            db.commit()
    finally:
        db.close()
    return {"expired": expired, "stalled": stale, "scanned": scanned}


# ─── Promotion ───────────────────────────────────────────────────────────────

def _jsonable(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return {"$dt": v.isoformat()}
    if isinstance(v, Decimal):
        return {"$dec": str(v)}
    if isinstance(v, (bytes, bytearray)):
        return {"$b64": base64.b64encode(bytes(v)).decode()}
    return v


def _from_json(v: Any) -> Any:
    if isinstance(v, dict):
        if "$dt" in v:
            return v["$dt"]
        if "$dec" in v:
            return Decimal(v["$dec"])
        if "$b64" in v:
            return base64.b64decode(v["$b64"])
    return v


def _order(cursor, schema: str, tables: list[str]) -> list[str]:
    """Parents before children among ``tables`` (foreign keys inside the set)."""
    cursor.execute("SELECT table_name, referenced_table_name FROM information_schema.key_column_usage "
                   "WHERE table_schema = %s AND referenced_table_name IS NOT NULL", (schema,))
    deps: dict[str, set] = {t: set() for t in tables}
    for child, parent in cursor.fetchall():
        if child in deps and parent in deps and child != parent:
            deps[child].add(parent)
    ordered, seen = [], set()

    def visit(t, stack=()):
        if t in seen or t in stack:
            return
        for p in sorted(deps[t]):
            visit(p, stack + (t,))
        seen.add(t)
        ordered.append(t)
    for t in sorted(tables):
        visit(t)
    return ordered


def request_promotion(db: Session, admin, cs: PlatformSandboxChangeSet, ip: str) -> dict:
    """Validate, then either queue for approval (Control Center sbPromote) or promote now."""
    if cs.status not in ("ready", "failed"):
        raise SandboxError(f"{code(cs)} is {cs.status.replace('_', ' ')}", 409)
    sb = db.get(PlatformSandbox, cs.sandbox_id) if cs.sandbox_id else None
    tenant = db.get(Tenant, cs.tenant_id)
    _validate(db, cs, sb, tenant)
    if policy(db, tenant.id)["approval"]:
        from app.models.tenant import PlatformApprovalRequest
        from app.routers.platform_router import _write_platform_audit
        row = PlatformApprovalRequest(action=APPROVAL_ACTION, module="databases", entity_type="change_set", entity_id=cs.id, entity_name=code(cs),
                                      summary=f"Promote {code(cs)} from sandbox '{cs.sandbox_name}' to {tenant.name} production: {cs.contents}"[:500],
                                      payload={"change_set_id": cs.id, "items": cs.items, "details_hash": _details_hash(cs.details)},
                                      status="pending", requested_by=admin.id if admin else None)
        db.add(row)
        db.flush()
        cs.status, cs.approval_request_id, cs.requested_by_id, cs.updated_at, cs.error = "awaiting_approval", row.id, admin.id if admin else None, datetime.utcnow(), None
        _write_platform_audit(db, admin, "request_approval", "approval_request", row.id, code(cs), f"Requested approval #{row.id}: {row.summary}", ip,
                              new_data={"action": APPROVAL_ACTION, "payload": row.payload})
        return {"approval_required": True, "request_id": row.id}
    return {"approval_required": False, **promote(db, admin, cs, ip)}


def _details_hash(details: dict) -> str:
    return hashlib.sha256(json.dumps(details, sort_keys=True, default=str).encode()).hexdigest()


def _validate(db: Session, cs: PlatformSandboxChangeSet, sb: Optional[PlatformSandbox], tenant: Optional[Tenant]) -> None:
    if tenant is None or tenant.status in ("suspended", "cancelled") or tenant.deletion_scheduled_at:
        raise SandboxError("The target tenant is not active – nothing can be promoted to it", 409)
    if sb is None or sb.status != "active" or sb.tenant_id != tenant.id:
        raise SandboxError("The source sandbox is no longer active", 409)
    _guard(sb, tenant)
    current = _diff(db, sb, tenant)
    if _details_hash(current) != _details_hash(cs.details):
        contents, items = _describe(current)
        cs.details, cs.contents, cs.items, cs.updated_at = current, contents or "No differences", items, datetime.utcnow()
        if cs.status == "promoting":
            cs.status = "ready"
        db.commit()
        raise SandboxError("The sandbox changed since this change set was captured – it has been updated, review it and promote again", 409)
    if not cs.items:
        raise SandboxError("This change set is empty", 409)
    unsupported = [t for t in cs.details if t not in PROMOTABLE]
    if unsupported:
        raise SandboxError(f"Not promotable: {', '.join(unsupported)}", 422)
    conn = _admin()
    try:
        with conn.cursor() as c:
            prod_meta = _promotable(c, tenant.db_name)
    finally:
        conn.close()
    for t, d in cs.details.items():
        if t not in prod_meta:
            raise SandboxError(f"{t} does not exist (with a single-column key) in production", 409)
        if prod_meta[t][0] != d["pk"] or sorted(map(tuple, prod_meta[t][2])) != sorted(map(tuple, d["signature"])):
            raise SandboxError(f"{t} has different columns in production and the sandbox – the schemas must match before promoting", 409)


def promote(db: Session, admin, cs: PlatformSandboxChangeSet, ip: str) -> dict:
    """Apply the change set to production in one transaction, after writing and verifying a rollback point."""
    from app.routers.platform_router import _write_platform_audit
    from app.services.platform_backup_service import dump_database

    sb = db.get(PlatformSandbox, cs.sandbox_id) if cs.sandbox_id else None
    tenant = db.get(Tenant, cs.tenant_id)
    _validate(db, cs, sb, tenant)
    cs.status, cs.updated_at = "promoting", datetime.utcnow()
    db.commit()
    actor = (admin.full_name or admin.username) if admin else "system"
    prod = validate_mysql_identifier(tenant.db_name, field_name="database name")
    tables = list(cs.details)
    ROLLBACK_DIR.mkdir(parents=True, exist_ok=True)
    sbconn = _sandbox_conn(sb, tenant)
    conn = _admin(prod, autocommit=False, read_timeout=600)
    try:
        with conn.cursor() as c, sbconn.cursor() as s:
            order = _order(c, prod, tables)
            meta = {t: (cs.details[t]["pk"], [col for col, _ in cs.details[t]["signature"]]) for t in tables}
            # 1. Lock the affected production rows and check nothing changed there since the sandbox was copied.
            before: dict[str, list] = {}
            conflicts = []
            for t in order:
                pk, cols = meta[t]
                d = cs.details[t]
                keys = d["added"] + d["changed"] + d["removed"]
                ph = ", ".join(["%s"] * len(keys))
                c.execute(_hash_sql(t, pk, cols, f" WHERE {_q(pk)} IN ({ph}) FOR UPDATE"), keys)
                now = {str(k): h for k, h in c.fetchall()}
                conflicts += [f"{t}#{k} already exists" for k in d["added"] if k in now]
                conflicts += [f"{t}#{k} changed in production" for k in d["changed"] + d["removed"] if now.get(k) != d["base"].get(k)]
                c.execute(f"SELECT {', '.join(_q(x) for x in cols)} FROM {_q(t)} WHERE {_q(pk)} IN ({ph})", keys)
                before[t] = [[_jsonable(v) for v in row] for row in c.fetchall()]
            if conflicts:
                raise SandboxError("Production changed since the sandbox was copied – not promoted: " + "; ".join(conflicts[:10]), 409)
            # 2. Rollback point: before-images (exact undo) + SQL dump of the affected tables; both verified.
            stamp = f"{code(cs)}-{datetime.utcnow():%Y%m%d%H%M%S}"
            path = ROLLBACK_DIR / f"{stamp}.json"
            point = {"change_set": cs.id, "tenant_id": tenant.id, "database": prod, "created_at": datetime.utcnow().isoformat(),
                     "tables": {t: {"pk": meta[t][0], "columns": meta[t][1], "rows": before[t]} for t in order}}
            path.write_text(json.dumps(point), encoding="utf-8")
            check = json.loads(path.read_text(encoding="utf-8"))
            if any(len(check["tables"][t]["rows"]) != len(before[t]) for t in order):
                raise SandboxError("The rollback point could not be verified – nothing was promoted", 500)
            dump = dump_database(prod, tables=order, directory=ROLLBACK_DIR)
            if not (ROLLBACK_DIR / dump).stat().st_size:
                raise SandboxError("The rollback dump is empty – nothing was promoted", 500)
            # 3. Apply: deletes children-first, then inserts / updates parents-first. Foreign keys stay enforced.
            c.execute("SET FOREIGN_KEY_CHECKS = 1")
            for t in reversed(order):
                pk, _cols = meta[t]
                for k in cs.details[t]["removed"]:
                    c.execute(f"DELETE FROM {_q(t)} WHERE {_q(pk)} = %s", (k,))
            for t in order:
                pk, cols = meta[t]
                d = cs.details[t]
                keys = d["added"] + d["changed"]
                if not keys:
                    continue
                s.execute(f"SELECT {', '.join(_q(x) for x in cols)} FROM {_q(t)} WHERE {_q(pk)} IN ({', '.join(['%s'] * len(keys))})", keys)
                for row in s.fetchall():
                    values = dict(zip(cols, row))
                    key = str(values[pk])
                    if key in d["added"]:
                        c.execute(f"INSERT INTO {_q(t)} ({', '.join(_q(x) for x in cols)}) VALUES ({', '.join(['%s'] * len(cols))})", row)
                    else:
                        sets = [x for x in cols if x != pk]
                        c.execute(f"UPDATE {_q(t)} SET {', '.join(f'{_q(x)} = %s' for x in sets)} WHERE {_q(pk)} = %s", [values[x] for x in sets] + [values[pk]])
            # 4. Verify inside the transaction: production rows now match the sandbox.
            for t in order:
                pk, cols = meta[t]
                d = cs.details[t]
                keys = d["added"] + d["changed"] + d["removed"]
                c.execute(_hash_sql(t, pk, cols, f" WHERE {_q(pk)} IN ({', '.join(['%s'] * len(keys))})"), keys)
                now = {str(k): h for k, h in c.fetchall()}
                if any(now.get(k) != d["new"].get(k) for k in d["added"] + d["changed"]) or any(k in now for k in d["removed"]):
                    raise SandboxError(f"{t} did not match the sandbox after applying – rolled back", 500)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        db.rollback()
        cs = db.get(PlatformSandboxChangeSet, cs.id)
        cs.status, cs.error, cs.updated_at = "failed", str(exc)[:2000], datetime.utcnow()
        _write_platform_audit(db, admin, "change_set_promotion_failed", "change_set", cs.id, code(cs),
                              f"{code(cs)} not promoted to {tenant.name}: {str(exc)[:300]} (production unchanged)", ip)
        db.commit()
        if isinstance(exc, SandboxError):
            raise
        raise SandboxError(f"Promotion failed – production unchanged: {exc}", 500)
    finally:
        conn.close()
        sbconn.close()
    # The sandbox now matches production for these rows: move the baseline so they are no longer differences.
    with master_engine.begin() as m:
        for t, d in cs.details.items():
            for k in d["changed"] + d["removed"]:
                m.execute(PlatformSandboxBaseline.__table__.delete().where(PlatformSandboxBaseline.sandbox_id == sb.id,
                                                                           PlatformSandboxBaseline.table_name == t, PlatformSandboxBaseline.pk == k))
            rows = [{"sandbox_id": sb.id, "table_name": t, "pk": k, "row_hash": d["new"][k]} for k in d["added"] + d["changed"]]
            if rows:
                m.execute(PlatformSandboxBaseline.__table__.insert(), rows)
    cs.status, cs.promoted_by, cs.promoted_at, cs.error = "promoted", actor, datetime.utcnow(), None
    cs.rollback_path, cs.rollback_dump, cs.rollback_verified_at, cs.updated_at = str(path), str(ROLLBACK_DIR / dump), datetime.utcnow(), datetime.utcnow()
    _write_platform_audit(db, admin, "change_set_promoted", "change_set", cs.id, code(cs),
                          f"{code(cs)} promoted from sandbox '{cs.sandbox_name}' to {tenant.name} production: {cs.items} item(s) – {cs.contents}",
                          ip, new_data={"tables": sorted(cs.details), "items": cs.items, "rollback_point": path.name, "rollback_dump": dump})
    db.commit()
    return {"promoted": cs.items, "rollback_point": path.name}


def rollback(db: Session, admin, cs: PlatformSandboxChangeSet, ip: str) -> dict:
    """Restore the before-images of a promoted change set, if production still holds exactly what was promoted."""
    from app.routers.platform_router import _write_platform_audit

    if cs.status != "promoted" or not cs.rollback_path:
        raise SandboxError(f"{code(cs)} is not a promoted change set with a rollback point", 409)
    path = Path(cs.rollback_path)
    if not path.is_file():
        raise SandboxError("The rollback point file is missing on this server", 409)
    point = json.loads(path.read_text(encoding="utf-8"))
    tenant = db.get(Tenant, cs.tenant_id)
    if point["database"] != tenant.db_name:
        raise SandboxError("The rollback point belongs to another database", 409)
    conn = _admin(tenant.db_name, autocommit=False, read_timeout=600)
    try:
        with conn.cursor() as c:
            order = _order(c, tenant.db_name, list(point["tables"]))
            for t in order:
                d, spec = cs.details[t], point["tables"][t]
                pk, cols = spec["pk"], spec["columns"]
                keys = d["added"] + d["changed"] + d["removed"]
                c.execute(_hash_sql(t, pk, cols, f" WHERE {_q(pk)} IN ({', '.join(['%s'] * len(keys))}) FOR UPDATE"), keys)
                now = {str(k): h for k, h in c.fetchall()}
                if any(now.get(k) != d["new"].get(k) for k in d["added"] + d["changed"]) or any(k in now for k in d["removed"]):
                    raise SandboxError(f"{t} was changed in production after the promotion – roll back manually from {cs.rollback_dump}", 409)
            c.execute("SET FOREIGN_KEY_CHECKS = 1")
            for t in reversed(order):
                pk = point["tables"][t]["pk"]
                for k in cs.details[t]["added"]:
                    c.execute(f"DELETE FROM {_q(t)} WHERE {_q(pk)} = %s", (k,))
            for t in order:
                spec = point["tables"][t]
                pk, cols = spec["pk"], spec["columns"]
                for row in spec["rows"]:
                    values = [_from_json(v) for v in row]
                    data = dict(zip(cols, values))
                    if str(data[pk]) in cs.details[t]["removed"]:
                        c.execute(f"INSERT INTO {_q(t)} ({', '.join(_q(x) for x in cols)}) VALUES ({', '.join(['%s'] * len(cols))})", values)
                    else:
                        sets = [x for x in cols if x != pk]
                        c.execute(f"UPDATE {_q(t)} SET {', '.join(f'{_q(x)} = %s' for x in sets)} WHERE {_q(pk)} = %s", [data[x] for x in sets] + [data[pk]])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    cs.status, cs.rolled_back_at, cs.updated_at = "rolled_back", datetime.utcnow(), datetime.utcnow()
    if cs.sandbox_id:  # those rows differ from production again: back to the original baseline
        with master_engine.begin() as m:
            for t, d in cs.details.items():
                for k in d["added"] + d["changed"]:
                    m.execute(PlatformSandboxBaseline.__table__.delete().where(PlatformSandboxBaseline.sandbox_id == cs.sandbox_id,
                                                                               PlatformSandboxBaseline.table_name == t, PlatformSandboxBaseline.pk == k))
                rows = [{"sandbox_id": cs.sandbox_id, "table_name": t, "pk": k, "row_hash": d["base"][k]} for k in d["changed"] + d["removed"]]
                if rows:
                    m.execute(PlatformSandboxBaseline.__table__.insert(), rows)
    _write_platform_audit(db, admin, "change_set_rolled_back", "change_set", cs.id, code(cs),
                          f"{code(cs)} rolled back in {tenant.name} production from rollback point {path.name}", ip)
    db.commit()
    return {"rolled_back": cs.items}


def on_approved(db: Session, approver, payload: dict, ip: str = "system") -> dict:
    """Approval-queue executor for ``promote_change_set``."""
    cs = db.get(PlatformSandboxChangeSet, int(payload["change_set_id"]))
    if cs is None or cs.status != "awaiting_approval":
        raise SandboxError("This change set is no longer waiting for approval", 409)
    if payload.get("details_hash") != _details_hash(cs.details):
        cs.status = "ready"
        db.commit()
        raise SandboxError("The change set changed after approval was requested – request approval again", 409)
    cs.status = "ready"
    return promote(db, approver, cs, ip)


# ─── Page data ───────────────────────────────────────────────────────────────

def _sync_approvals(db: Session, sets: list[PlatformSandboxChangeSet]) -> None:
    """Change sets whose approval request was rejected or withdrawn go back to Ready to promote (one batch query)."""
    from app.models.tenant import PlatformApprovalRequest
    waiting = {cs.approval_request_id: cs for cs in sets if cs.status == "awaiting_approval" and cs.approval_request_id}
    if not waiting:
        return
    for rid, status in db.query(PlatformApprovalRequest.id, PlatformApprovalRequest.status).filter(PlatformApprovalRequest.id.in_(waiting)).all():
        if status in ("rejected", "cancelled", "withdrawn", "expired"):
            cs = waiting[rid]
            cs.status, cs.error, cs.updated_at = "ready", f"Approval request #{rid} was {status}", datetime.utcnow()
    db.commit()


STATUS_LABEL = {"provisioning": "Provisioning", "active": "Active", "refreshing": "Refreshing", "failed": "Failed", "expired": "Expired", "deleted": "Deleted"}
SET_LABEL = {"ready": "Ready to promote", "awaiting_approval": "Awaiting approval", "promoting": "Promoting", "promoted": "Promoted",
             "failed": "Failed", "rolled_back": "Rolled back", "superseded": "Superseded"}


def overview(db: Session, allowed: Optional[set[int]], offset: int, limit: int, cs_offset: int, cs_limit: int) -> dict:
    ensure_schema()
    now = datetime.utcnow()
    live = db.query(PlatformSandbox).filter(PlatformSandbox.status.in_(LIVE))
    sets = db.query(PlatformSandboxChangeSet).filter(PlatformSandboxChangeSet.status != "superseded")
    if allowed is not None:
        live = live.filter(PlatformSandbox.tenant_id.in_(allowed or {0}))
        sets = sets.filter(PlatformSandboxChangeSet.tenant_id.in_(allowed or {0}))
    # KPIs – grouped aggregates, no per-row queries
    k_live, k_size, k_exp = (live.with_entities(func.count(PlatformSandbox.id), func.coalesce(func.sum(PlatformSandbox.size_mb), 0),
                                                func.sum(case(((PlatformSandbox.status == "active") & (PlatformSandbox.expires_at <= now + timedelta(days=14)), 1), else_=0)))
                             .order_by(None).one())
    pending = sets.filter(PlatformSandboxChangeSet.status.in_(OPEN_SETS)).order_by(None).count()
    total = live.order_by(None).count()
    rows = (live.order_by(PlatformSandbox.created_at.desc(), PlatformSandbox.id.desc()).offset(offset).limit(limit).all())
    cs_total = sets.order_by(None).count()
    cs_rows = sets.order_by(PlatformSandboxChangeSet.id.desc()).offset(cs_offset).limit(cs_limit).all()
    _sync_approvals(db, cs_rows)
    tenant_ids = {r.tenant_id for r in rows} | {c.tenant_id for c in cs_rows}
    names = dict(db.query(Tenant.id, Tenant.name).filter(Tenant.id.in_(tenant_ids or {0})).all())
    eligible = db.query(Tenant.id, Tenant.name).filter(Tenant.status.in_(("active", "trial")), Tenant.deletion_scheduled_at.is_(None))
    if allowed is not None:
        eligible = eligible.filter(Tenant.id.in_(allowed or {0}))
    return {
        "kpis": {"sandboxes": int(k_live or 0), "storage_mb": round(float(k_size or 0), 2), "pending_change_sets": pending, "expiring_14d": int(k_exp or 0)},
        "environments": {"items": [{
            "id": r.id, "name": r.name, "tenant_id": r.tenant_id, "tenant": names.get(r.tenant_id, "—"), "source": SOURCES[r.source], "source_key": r.source,
            "size_mb": r.size_mb, "created_at": _utc(r.created_at), "expires_at": _utc(r.expires_at), "status": STATUS_LABEL[r.status],
            "progress": r.progress, "error": r.error, "database": r.db_name, "masking_verified": r.masking_verified_at is not None,
            "expires_in_days": (r.expires_at - now).days,
        } for r in rows], "total": total, "offset": offset, "limit": limit},
        "change_sets": {"items": [{
            "id": c.id, "code": code(c), "contents": c.contents, "tenant": names.get(c.tenant_id, "—"), "from_sandbox": c.sandbox_name, "items": c.items,
            "status": SET_LABEL[c.status], "status_key": c.status, "error": c.error, "approval_request_id": c.approval_request_id,
            "promoted_at": _utc(c.promoted_at), "promoted_by": c.promoted_by, "can_rollback": c.status == "promoted" and bool(c.rollback_path),
        } for c in cs_rows], "total": cs_total, "offset": cs_offset, "limit": cs_limit},
        "tenants": [{"id": t.id, "name": t.name} for t in eligible.order_by(Tenant.name).all()],
        "defaults": {"days": int(controls.value(db, "sbDays", None))},
    }
