"""Migrations into a tenant from CSV / Excel files, a SQL dump or a connected CRM (migration_connectors).

Steps (prototype wizard): Source → Objects & fields → Rules → Dry run → Cut-over.
CSV/XLSX uploads are read directly; a SQL dump is restored into a temporary staging MariaDB database
and its tables become the source datasets. Records are imported into the tenant's Customers and Leads
(customers are created active and approved, as decided for platform migrations) and every created id is
kept so the migration can be rolled back within 7 days.
"""

from __future__ import annotations

import csv
import io
import logging
import re
import shutil
import threading
from datetime import date, datetime, timedelta
from pathlib import Path

import pymysql
from sqlalchemy import bindparam, text

from app.core.config import settings
from app.database import MasterSessionLocal, get_tenant_session, master_engine, validate_mysql_identifier
from app.models.tenant import Tenant
from app.models.tenant_hierarchy import TenantMigration
from app.services.tenant_data_transfer import MIGRATION_DIR, _connect

logger = logging.getLogger(__name__)

MIGRATION_SOURCES = ("CSV / Excel files", "SQL dump / database")
ROLLBACK_WINDOW = timedelta(days=7)
BATCH = 200  # rows per commit; also the checkpoint for pause / resume / crash recovery
RESUMABLE = ("Paused", "Interrupted", "Failed")
INTERRUPTED = "Interrupted before it finished (server restart or crash) – resume to continue from the last checkpoint"
DUPLICATE_RULES = ("Skip duplicates", "Update existing", "Create anyway")
OWNER_RULES = ("Match owners by email", "Assign all to tenant admin", "Round-robin")
GST_PATTERN = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$", re.I)
DATE_FORMATS = ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%d/%m/%Y", "%d-%m-%Y", "%m/%d/%Y", "%d/%m/%Y %H:%M", "%d %b %Y")

# (key, label, required). owner_email / external_id / created_at / notes / contact_* are handled by the importer.
# Order = import order: accounts and products first, so contacts, deals, quotes and activities can link to them.
TARGETS = {
    "customers": {"label": "Accounts", "fields": [
        ("customer_name", "Customer name", True), ("customer_vertical", "Vertical", False), ("division", "Division", False),
        ("group_name", "Group", False), ("billing_address", "Billing address", False), ("billing_city", "City", False),
        ("billing_state", "State", False), ("billing_pincode", "Pincode", False), ("billing_country", "Country", False),
        ("gst_number", "GST number", False), ("pan_number", "PAN number", False), ("website", "Website", False),
        ("account_status", "Account status", False), ("account_potential", "Account potential", False),
        ("potential_value", "Potential value", False), ("remarks", "Remarks", False), ("contact_name", "Contact name", False),
        ("contact_designation", "Contact designation", False), ("contact_mobile", "Contact mobile", False),
        ("contact_email", "Contact email", False), ("owner_email", "Owner email", False), ("external_id", "Original record ID", False),
        ("created_at", "Created date", False), ("notes", "Notes", False)]},
    "products": {"label": "Products", "fields": [
        ("name", "Product name", True), ("category", "Category", False), ("description", "Description", False),
        ("external_id", "Original record ID", False), ("created_at", "Created date", False)]},
    "contacts": {"label": "Contacts", "fields": [
        ("contact_name", "Full name", False), ("first_name", "First name", False), ("last_name", "Last name", False),
        ("customer_name", "Account (customer name)", True), ("designation", "Designation", False), ("department", "Department", False),
        ("mobile", "Mobile", False), ("office_phone", "Office phone", False), ("office_email", "E-mail", False), ("notes", "Notes", False),
        ("external_id", "Original record ID", False), ("created_at", "Created date", False)]},
    "leads": {"label": "Leads", "fields": [
        ("lead_title", "Lead title", True), ("customer_name", "Customer name", False), ("contact_person", "Contact person", False),
        ("designation", "Designation", False), ("mobile", "Mobile", False), ("email", "Email", False), ("priority", "Priority", False),
        ("status", "Status", False), ("est_value", "Estimated value", False), ("region", "Region", False), ("branch", "Branch", False),
        ("product_description", "Product description", False), ("notes", "Notes", False), ("owner_email", "Owner email", False),
        ("external_id", "Original record ID", False), ("created_at", "Created date", False)]},
    "deals": {"label": "Deals", "fields": [
        ("lead_title", "Deal name", True), ("customer_name", "Account (customer name)", False), ("contact_person", "Contact person", False),
        ("mobile", "Mobile", False), ("email", "Email", False), ("est_value", "Amount", False), ("stage", "Stage", False),
        ("close_date", "Expected close date", False), ("product_description", "Description", False), ("notes", "Notes", False),
        ("owner_email", "Owner email", False), ("external_id", "Original record ID", False), ("created_at", "Created date", False)]},
    "quotes": {"label": "Quotes", "fields": [
        ("subject", "Subject", True), ("customer_name", "Account (customer name)", False), ("quote_number", "Original quote number", False),
        ("amount", "Sub-total", False), ("tax_amount", "Tax", False), ("total_amount", "Total", False), ("valid_until", "Valid until", False),
        ("status", "Status", False), ("notes", "Notes", False), ("terms_conditions", "Terms & conditions", False),
        ("owner_email", "Owner email", False), ("external_id", "Original record ID", False), ("created_at", "Created date", False)]},
    "activities": {"label": "Activities", "fields": [
        ("subject", "Subject", True), ("activity_date", "Activity date", True), ("activity_type", "Type", False),
        ("customer_name", "Account (customer name)", False), ("description", "Description", False), ("status", "Status", False),
        ("outcome", "Outcome", False), ("owner_email", "Owner email", False), ("external_id", "Original record ID", False),
        ("created_at", "Created date", False)]},
}
_COMMON = {"owner": "owner_email", "owneremail": "owner_email", "id": "external_id", "recordid": "external_id",
           "hsobjectid": "external_id", "createddate": "created_at", "createdtime": "created_at", "createdon": "created_at",
           "createdate": "created_at", "createdat": "created_at", "dateadded": "created_at", "addtime": "created_at"}
SYNONYMS = {
    "customers": {**_COMMON, "accountname": "customer_name", "company": "customer_name", "companyname": "customer_name", "name": "customer_name",
                  "organization": "customer_name", "customer": "customer_name", "industry": "customer_vertical", "street": "billing_address",
                  "billingstreet": "billing_address", "address": "billing_address", "city": "billing_city", "billingcity": "billing_city",
                  "state": "billing_state", "billingstate": "billing_state", "zip": "billing_pincode", "postalcode": "billing_pincode",
                  "pincode": "billing_pincode", "country": "billing_country", "gst": "gst_number", "gstin": "gst_number", "pan": "pan_number",
                  "web": "website", "url": "website", "domain": "website", "status": "account_status", "rating": "account_potential",
                  "annualrevenue": "potential_value", "description": "remarks", "contact": "contact_name", "contactname": "contact_name",
                  "fullname": "contact_name", "title": "contact_designation", "phone": "contact_mobile", "mobile": "contact_mobile",
                  "email": "contact_email", "note": "notes"},
    "products": {**_COMMON, "name": "name", "productname": "name", "product": "name", "displayname": "name", "category": "category",
                 "productfamily": "category", "family": "category", "productcategory": "category", "type": "category",
                 "description": "description", "productdescription": "description"},
    "contacts": {**_COMMON, "name": "contact_name", "fullname": "contact_name", "contactname": "contact_name", "firstname": "first_name",
                 "lastname": "last_name", "account": "customer_name", "accountname": "customer_name", "company": "customer_name",
                 "companyname": "customer_name", "organization": "customer_name", "orgname": "customer_name", "orgid": "customer_name",
                 "parentcustomerid": "customer_name", "title": "designation", "jobtitle": "designation", "department": "department",
                 "mobile": "mobile", "mobilephone": "mobile", "phone": "office_phone", "workphone": "office_phone", "businessphone": "office_phone",
                 "telephone1": "office_phone", "email": "office_email", "emailaddress": "office_email", "emailaddress1": "office_email",
                 "description": "notes", "note": "notes"},
    "leads": {**_COMMON, "subject": "lead_title", "title": "lead_title", "leadname": "lead_title", "name": "lead_title",
              "company": "customer_name", "account": "customer_name", "accountname": "customer_name", "contact": "contact_person",
              "contactname": "contact_person", "fullname": "contact_person", "phone": "mobile", "amount": "est_value", "value": "est_value",
              "description": "product_description", "leadstatus": "status", "stage": "status", "note": "notes"},
    "deals": {**_COMMON, "dealname": "lead_title", "opportunityname": "lead_title", "name": "lead_title", "title": "lead_title",
              "subject": "lead_title", "account": "customer_name", "accountname": "customer_name", "company": "customer_name",
              "orgname": "customer_name", "orgid": "customer_name", "partnerid": "customer_name", "customerid": "customer_name",
              "contact": "contact_person", "contactname": "contact_person", "personname": "contact_person", "personid": "contact_person",
              "amount": "est_value", "value": "est_value", "dealvalue": "est_value", "expectedrevenue": "est_value", "estimatedvalue": "est_value",
              "monetaryvalue": "est_value", "stage": "stage", "stagename": "stage", "dealstage": "stage", "status": "stage", "stageid": "stage",
              "closedate": "close_date", "expectedclosedate": "close_date", "estimatedclosedate": "close_date", "estimatedclosingdate": "close_date",
              "dateclosed": "close_date", "description": "product_description", "note": "notes", "notes": "notes"},
    "quotes": {**_COMMON, "subject": "subject", "quotename": "subject", "name": "subject", "title": "subject",
               "account": "customer_name", "accountname": "customer_name", "company": "customer_name", "customer": "customer_name",
               "partnerid": "customer_name", "customerid": "customer_name", "quotenumber": "quote_number", "number": "quote_number",
               "quotationnumber": "quote_number", "subtotal": "amount", "amount": "amount", "amountuntaxed": "amount", "tax": "tax_amount",
               "taxamount": "tax_amount", "totaltax": "tax_amount", "amounttax": "tax_amount", "grandtotal": "total_amount", "total": "total_amount",
               "totalamount": "total_amount", "totalprice": "total_amount", "amounttotal": "total_amount", "validuntil": "valid_until",
               "expirationdate": "valid_until", "validtill": "valid_until", "expirydate": "valid_until", "validityenddate": "valid_until",
               "status": "status", "quotestage": "status", "state": "status", "description": "notes", "note": "notes",
               "terms": "terms_conditions", "termsconditions": "terms_conditions", "termsandconditions": "terms_conditions"},
    "activities": {**_COMMON, "subject": "subject", "title": "subject", "name": "subject", "type": "activity_type",
                   "activitytype": "activity_type", "tasktype": "activity_type", "activitydate": "activity_date", "date": "activity_date",
                   "duedate": "activity_date", "duedatetime": "activity_date", "activitydatetime": "activity_date", "startdate": "activity_date",
                   "scheduledstart": "activity_date", "account": "customer_name", "accountname": "customer_name", "company": "customer_name",
                   "orgname": "customer_name", "relatedto": "customer_name", "description": "description", "comments": "description",
                   "note": "description", "status": "status", "outcome": "outcome", "result": "outcome", "assignedto": "owner_email"},
}
# Source objects whose name tells the target (checked in order: "crm.lead" is a lead, "opportunity" a deal, ...).
_NAME_TARGETS = [("quot", "quotes"), ("sale.order", "quotes"), ("product", "products"), ("deal", "deals"), ("opportunit", "deals"),
                 ("lead", "leads"), ("enquir", "leads"), ("inquir", "leads"), ("contact", "contacts"), ("person", "contacts"),
                 ("task", "activities"), ("activit", "activities"), ("event", "activities"), ("call", "activities"), ("meeting", "activities"),
                 ("account", "customers"), ("customer", "customers"), ("compan", "customers"), ("organi", "customers"), ("client", "customers"),
                 ("partner", "customers")]
STATUS_ENUMS = (("leads", "status"), ("quotations", "status"), ("kam_activities", "status"))


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def auto_mapping(target: str, columns: list[str]) -> dict[str, str]:
    """Map source columns to target fields by key/label match, then CRM-export synonyms."""
    fields = {key: label for key, label, _ in TARGETS[target]["fields"]}
    by_norm = {_norm(k): k for k in fields} | {_norm(v): k for k, v in fields.items()}
    mapping, used = {}, set()
    for column in columns:
        key = by_norm.get(_norm(column)) or SYNONYMS[target].get(_norm(column))
        if key and key not in used:
            mapping[column] = key
            used.add(key)
    return mapping


def _guess_target(name: str, columns: list[str]) -> str | None:
    n = (name or "").lower()
    for word, target in _NAME_TARGETS:
        if word in n:
            return target
    scores = {t: len(auto_mapping(t, columns)) for t in TARGETS}
    best = max(scores, key=scores.get)
    return best if scores[best] >= 2 else None


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip()


def read_rows(migration: TenantMigration, dataset: dict):
    """Yield {column: text} rows for one dataset (CSV file, Excel sheet or staging table)."""
    if dataset["kind"] == "table":
        connection = _connect(migration.staging_db, cursorclass=pymysql.cursors.SSDictCursor)
        try:
            with connection.cursor() as cursor:
                cursor.execute(f"SELECT * FROM `{validate_mysql_identifier(dataset['name'], field_name='table name')}` ORDER BY 1")
                for row in cursor:
                    yield {k: _cell(v) for k, v in row.items()}
        finally:
            connection.close()
        return
    path = MIGRATION_DIR / str(migration.id) / dataset["file"]
    if dataset["kind"] == "csv":
        content = path.read_bytes().decode("utf-8-sig", errors="replace")
        try:
            dialect = csv.Sniffer().sniff(content[:4096], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        for row in csv.DictReader(io.StringIO(content), dialect=dialect):
            yield {(k or "").strip(): _cell(v) for k, v in row.items() if k}
        return
    from openpyxl import load_workbook
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        rows = workbook[dataset["sheet"]].iter_rows(values_only=True)
        header = [_cell(h) for h in next(rows, [])]
        for values in rows:
            if values and any(v not in (None, "") for v in values):
                yield {header[i]: _cell(v) for i, v in enumerate(values) if i < len(header) and header[i]}
    finally:
        workbook.close()


def _describe(migration: TenantMigration, dataset: dict) -> dict:
    rows = list(read_rows(migration, dataset))
    columns = list(dict.fromkeys(k for r in rows[:200] for k in r))
    target = _guess_target(dataset["name"], columns)
    return {**dataset, "columns": columns, "rows": len(rows), "sample": rows[:3], "target": target,
            "suggested": auto_mapping(target, columns) if target else {}}


def _restore_staging(migration_id: int, dumps: list[Path]) -> str:
    from app.services.tenant_hierarchy import _split_sql
    target = validate_mysql_identifier(f"{settings.TENANT_DB_PREFIX}mig_staging_{migration_id}", field_name="database name")
    connection = _connect(autocommit=True, read_timeout=600)
    try:
        with connection.cursor() as cursor:
            cursor.execute(f"CREATE DATABASE `{target}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
            cursor.execute(f"USE `{target}`")
            cursor.execute("SET FOREIGN_KEY_CHECKS=0")
            for dump in dumps:
                for sql in _split_sql(dump.read_text(encoding="utf-8", errors="replace")):
                    # Statements that could leave the staging database are never executed.
                    if re.match(r"^\s*(USE|CREATE\s+DATABASE|DROP\s+DATABASE|DELIMITER|GRANT|REVOKE|CREATE\s+USER|SET\s+GLOBAL|LOAD\s+DATA|SELECT\s.+\sINTO\s+OUTFILE)\b", sql, re.I | re.S):
                        continue
                    cursor.execute(sql)
    except Exception:
        with connection.cursor() as cursor:
            cursor.execute(f"DROP DATABASE IF EXISTS `{target}`")
        raise
    finally:
        connection.close()
    return target


def drop_staging(migration: TenantMigration) -> None:
    if migration.staging_db:
        connection = _connect(autocommit=True)
        try:
            with connection.cursor() as cursor:
                cursor.execute(f"DROP DATABASE IF EXISTS `{validate_mysql_identifier(migration.staging_db, field_name='database name')}`")
        finally:
            connection.close()


def create_migration(db, tenant: Tenant, source: str, uploads: list[tuple[str, bytes]], actor: str) -> TenantMigration:
    if source not in MIGRATION_SOURCES:
        raise ValueError("Unknown source")
    if not uploads:
        raise ValueError("Upload at least one file")
    migration = TenantMigration(tenant_id=tenant.id, source=source, status="Draft", created_by=actor,
                                rules={"dup": DUPLICATE_RULES[0], "own": OWNER_RULES[0], "ids": True, "dates": True, "notes": True})
    db.add(migration)
    db.flush()
    folder = MIGRATION_DIR / str(migration.id)
    folder.mkdir(parents=True, exist_ok=True)
    datasets, names = [], []
    try:
        for original, content in uploads:
            safe = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(original).name)[:120] or "upload"
            (folder / safe).write_bytes(content)
            names.append(safe)
            lower = safe.lower()
            if source == MIGRATION_SOURCES[0]:
                if lower.endswith((".csv", ".txt")):
                    datasets.append({"key": safe, "name": Path(safe).stem, "kind": "csv", "file": safe})
                elif lower.endswith((".xlsx", ".xlsm")):
                    from openpyxl import load_workbook
                    workbook = load_workbook(folder / safe, read_only=True)
                    datasets.extend({"key": f"{safe}:{sheet}", "name": sheet, "kind": "xlsx", "file": safe, "sheet": sheet} for sheet in workbook.sheetnames)
                    workbook.close()
                else:
                    raise ValueError(f"{original}: upload .csv or .xlsx files")
            elif not lower.endswith(".sql"):
                raise ValueError(f"{original}: upload a .sql dump file")
        if source == MIGRATION_SOURCES[1]:
            migration.staging_db = _restore_staging(migration.id, [folder / n for n in names])
            connection = _connect(migration.staging_db)
            try:
                with connection.cursor() as cursor:
                    cursor.execute("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")
                    datasets = [{"key": t, "name": t, "kind": "table"} for (t, _) in cursor.fetchall()]
            finally:
                connection.close()
        migration.files = names
        migration.datasets = [_describe(migration, d) for d in datasets]
        migration.mapping = {d["key"]: {"enabled": bool(d["target"]), "target": d["target"], "fields": d["suggested"]} for d in migration.datasets}
        migration.records = sum(d["rows"] for d in migration.datasets)
    except Exception:
        drop_staging(migration)
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return migration


def create_connector_migration(db, tenant: Tenant, source: str, objects: list[str], actor: str) -> TenantMigration:
    """Start a migration whose source objects are pulled from a connected CRM in the background."""
    from app.services import migration_connectors as mc
    if source not in mc.CONNECTORS:
        raise ValueError("Unknown source")
    if not objects:
        raise ValueError("Select at least one object to pull")
    migration = TenantMigration(tenant_id=tenant.id, source=source, status="Fetching", created_by=actor, files=[], datasets=[], mapping={}, progress=0,
                                rules={"dup": DUPLICATE_RULES[0], "own": OWNER_RULES[0], "ids": True, "dates": True, "notes": True},
                                result={"pull": {"objects": objects, "done": {}}})
    db.add(migration)
    db.flush()
    return migration


def _pull(migration_id: int) -> None:
    connection = master_engine.connect()  # held while pulling: a 'Fetching' migration whose lock is free was interrupted
    try:
        if connection.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": f"tenant_migration_pull_{migration_id}"}).scalar() == 1:
            try:
                _pull_locked(migration_id)
            finally:
                connection.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": f"tenant_migration_pull_{migration_id}"})
    finally:
        connection.close()


def _pull_locked(migration_id: int) -> None:
    from app.models.tenant_hierarchy import PlatformMigrationConnector
    from app.services import migration_connectors as mc
    db = MasterSessionLocal()
    migration = db.get(TenantMigration, migration_id)
    connector = db.get(PlatformMigrationConnector, migration.source)
    objects = list((migration.result or {}).get("pull", {}).get("objects", []))
    db.close()
    folder = MIGRATION_DIR / str(migration_id)
    folder.mkdir(parents=True, exist_ok=True)
    done: dict[str, int] = {}

    def progress(obj: str, count: int) -> None:
        done[obj] = count
        _set(migration_id, progress=min(99, int(len([o for o in objects if o in done]) / max(1, len(objects)) * 100)),
             result={"pull": {"objects": objects, "done": dict(done)}})

    try:
        if not connector or connector.status != "connected":
            raise mc.ConnectorError(f"{migration.source} is not connected – set it up under Source connectors")
        written = mc.pull(migration.source, mc.decrypt_config(connector.config), objects, folder, progress)
        db = MasterSessionLocal()
        try:
            m = db.get(TenantMigration, migration_id)
            m.files = [f for f, _ in written]
            m.datasets = [_describe(m, {"key": f, "name": obj, "kind": "csv", "file": f}) for f, obj in written]
            m.mapping = {d["key"]: {"enabled": bool(d["target"]), "target": d["target"], "fields": d["suggested"]} for d in m.datasets}
            m.records, m.status, m.progress, m.result = sum(d["rows"] for d in m.datasets), "Draft", 0, {"pull": {"objects": objects, "done": done}}
            db.commit()
        finally:
            db.close()
    except Exception as exc:
        logger.warning("Pulling %s for migration %s failed", migration.source, migration_id, exc_info=True)
        _set(migration_id, status="Failed", error=f"Pull from {migration.source} failed: {exc}"[:1000])


def start_pull(migration_id: int) -> None:
    threading.Thread(target=_pull, args=(migration_id,), daemon=True, name=f"tenant-migration-pull-{migration_id}").start()


def _parse_date(value: str):
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(value.strip()[:19], fmt)
        except ValueError:
            continue
    return None


def _parse_number(value: str):
    cleaned = re.sub(r"[^0-9.\-]", "", value or "")
    try:
        return float(cleaned) if cleaned not in ("", "-", ".") else None
    except ValueError:
        return None


class _Context:
    """Tenant lookups shared by the dry run and the import."""

    def __init__(self, session, tenant: Tenant):
        q = lambda sql: session.execute(text(sql)).all()  # noqa: E731
        self.users = {(e or "").lower(): uid for uid, e in q("SELECT id, email FROM users WHERE is_active = 1")}
        admin = session.execute(text("SELECT id FROM users WHERE email = :e"), {"e": tenant.admin_email}).scalar()
        self.admin_id = admin or session.execute(text("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")).scalar()
        self.active_ids = sorted(self.users.values()) or [self.admin_id]
        self.customers = {(n or "").strip().lower(): cid for cid, n in q("SELECT id, customer_name FROM customers WHERE is_deleted = 0")}
        self.leads, self.deals = {}, {}
        for lid, t, c, kind in q("SELECT id, lead_title, customer_name, lead_type FROM leads"):
            (self.deals if kind == "direct_opportunity" else self.leads)[((t or "").strip().lower(), (c or "").strip().lower())] = lid
        self.products = {(n or "").strip().lower(): pid for pid, n in q("SELECT id, name FROM products_master")}
        self.contacts = {(cid, (n or "").strip().lower()): xid for xid, cid, n in q("SELECT id, customer_id, contact_name FROM customer_contacts")}
        self.quotes = {((s or "").strip().lower(), cid): qid for qid, s, cid in q("SELECT id, subject, customer_id FROM quotations")}
        self.quote_refs = {(r or "").strip().lower(): qid for qid, r in q("SELECT id, ref_number FROM quotations WHERE ref_number IS NOT NULL")}
        self.activities = {((s or "").strip().lower(), str(d), cid): aid for aid, s, d, cid in q("SELECT id, subject, activity_date, customer_id FROM kam_activities")}
        enums = {}
        for table, column in STATUS_ENUMS:
            kind = session.execute(text("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() "
                                        "AND TABLE_NAME = :t AND COLUMN_NAME = :c"), {"t": table, "c": column}).scalar() or ""
            enums[table] = re.findall(r"'([^']*)'", kind)
        self.lead_statuses, self.quote_statuses, self.activity_statuses = enums["leads"], enums["quotations"], enums["kam_activities"]
        self.rr = 0

    def owner(self, rules: dict, email: str) -> int:
        rule = rules.get("own", OWNER_RULES[0])
        if rule == OWNER_RULES[1]:
            return self.admin_id
        if rule == OWNER_RULES[2]:
            self.rr += 1
            return self.active_ids[(self.rr - 1) % len(self.active_ids)]
        return self.users.get((email or "").lower(), self.admin_id)

    def customer_id(self, values: dict):
        return self.customers.get((values.get("customer_name") or "").strip().lower())


def _contact_name(values: dict) -> str:
    return (values.get("contact_name") or " ".join(v for v in (values.get("first_name"), values.get("last_name")) if v)).strip()


def _pick(value: str, allowed: list[str]):
    """Case-insensitive match of a source status to the tenant's enum value (None when it has no equivalent)."""
    lookup = {a.lower(): a for a in allowed}
    return lookup.get((value or "").strip().lower())


def _deal_status(stage: str, statuses: list[str]) -> str:
    s = (stage or "").lower()
    if "lost" in s and "Lost" in statuses:
        return "Lost"
    if ("won" in s or "converted" in s) and "Converted" in statuses:
        return "Converted"
    return "Opportunity Created" if "Opportunity Created" in statuses else (statuses[0] if statuses else "Assigned")


def _check_row(target: str, values: dict, ctx: _Context, rules: dict, seen: set):
    """Return (errors, warnings, duplicate_key)."""
    errors, warnings = [], []
    if target == "contacts" and not values.get("contact_name"):
        values["contact_name"] = _contact_name(values)
    for key, label, required in TARGETS[target]["fields"]:
        if required and not values.get(key):
            errors.append(f"Missing required: {label}")
    if target == "contacts" and not values.get("contact_name"):
        errors.append("Missing required: Full name (or first / last name)")
    for key in ("potential_value", "est_value", "amount", "tax_amount", "total_amount"):
        if values.get(key) and _parse_number(values[key]) is None:
            warnings.append(f"Invalid number in {key.replace('_', ' ')}")
    for key in ("created_at", "close_date", "valid_until"):
        if values.get(key) and _parse_date(values[key]) is None:
            warnings.append(f"Invalid date in {key.replace('_', ' ')}")
    if target == "customers" and values.get("gst_number") and not GST_PATTERN.match(values["gst_number"]):
        errors.append("Invalid GST number format")
    if target == "leads" and values.get("status") and values["status"] not in ctx.lead_statuses:
        warnings.append("Unknown lead status (default used)")
    if target == "quotes" and values.get("status") and not _pick(values["status"], ctx.quote_statuses):
        warnings.append("Unknown quote status (Draft used)")
    if target == "activities":
        if values.get("activity_date") and _parse_date(values["activity_date"]) is None:
            errors.append("Invalid activity date")
        if values.get("status") and not _pick(values["status"], ctx.activity_statuses):
            warnings.append("Unknown activity status (set from the date)")
    customer_id = ctx.customer_id(values)
    if target == "contacts" and values.get("customer_name") and not customer_id:
        errors.append("Account not found (import it first or in the same migration)")
    if target in ("deals", "quotes", "activities") and values.get("customer_name") and not customer_id:
        warnings.append("Account not found (record kept without a link)")
    if rules.get("own", OWNER_RULES[0]) == OWNER_RULES[0] and values.get("owner_email") and values["owner_email"].lower() not in ctx.users:
        warnings.append("Unknown owner email (assigned to tenant admin)")
    key, existing = None, {}
    if target == "customers" and values.get("customer_name"):
        key, existing = values["customer_name"].strip().lower(), ctx.customers
    elif target in ("leads", "deals") and values.get("lead_title"):
        key, existing = (values["lead_title"].strip().lower(), (values.get("customer_name") or "").strip().lower()), (ctx.leads if target == "leads" else ctx.deals)
    elif target == "products" and values.get("name"):
        key, existing = values["name"].strip().lower(), ctx.products
    elif target == "contacts" and values.get("contact_name") and customer_id:
        key, existing = (customer_id, values["contact_name"].strip().lower()), ctx.contacts
    elif target == "quotes" and values.get("subject"):
        ref = (values.get("quote_number") or "").strip().lower()
        key, existing = (("ref", ref), {("ref", k): v for k, v in ctx.quote_refs.items()}) if ref else ((values["subject"].strip().lower(), customer_id), ctx.quotes)
    elif target == "activities" and values.get("subject") and values.get("activity_date"):
        day = _parse_date(values["activity_date"])
        key, existing = (values["subject"].strip().lower(), str(day.date()) if day else values["activity_date"], customer_id), ctx.activities
    dup = None
    if key is not None:
        dup = key if (key in existing or (target, key) in seen) else None
        seen.add((target, key))
    return errors, warnings, dup


def mapped(migration: TenantMigration):
    """Mapped datasets in import order (accounts and products before the records that link to them)."""
    order = list(TARGETS)
    picked = []
    for index, dataset in enumerate(migration.datasets or []):
        conf = (migration.mapping or {}).get(dataset["key"], {})
        if conf.get("enabled") and conf.get("target") in TARGETS:
            picked.append((order.index(conf["target"]), index, dataset, conf["target"], conf.get("fields", {})))
    for _, _, dataset, target, fields in sorted(picked, key=lambda p: (p[0], p[1])):
        yield dataset, target, fields


def dry_run(migration: TenantMigration, tenant: Tenant) -> dict:
    session = get_tenant_session(tenant.slug)
    try:
        ctx = _Context(session, tenant)
    finally:
        session.close()
    objects, issues = [], []
    totals = {"tot": 0, "ok": 0, "w": 0, "e": 0, "d": 0}
    skip_dups = (migration.rules or {}).get("dup", DUPLICATE_RULES[0]) == DUPLICATE_RULES[0]
    seen = set()
    for dataset, target, fields in mapped(migration):
        counts, top = {"n": 0, "w": 0, "e": 0, "d": 0}, {}
        for line, row in enumerate(read_rows(migration, dataset), start=2):
            values = {fields[c]: v for c, v in row.items() if c in fields and v}
            errors, warnings, dup = _check_row(target, values, ctx, migration.rules or {}, seen)
            if target == "customers" and not errors and values.get("customer_name"):
                # an account this migration will create: records linking to it validate against it (placeholder id)
                ctx.customers.setdefault(values["customer_name"].strip().lower(), -line)
            counts["n"] += 1
            counts["e"] += bool(errors)
            counts["w"] += bool(warnings) and not errors
            counts["d"] += bool(dup) and not errors
            for level, message in [("error", m) for m in errors] + [("warning", m) for m in warnings] + ([("duplicate", "Duplicate record")] if dup else []):
                top[message] = top.get(message, 0) + 1
                if len(issues) < 5000:
                    issues.append({"dataset": dataset["name"], "line": line, "level": level, "message": message})
        objects.append({"dataset": dataset["name"], "target": TARGETS[target]["label"], "records": counts["n"], "warnings": counts["w"],
                        "errors": counts["e"], "duplicates": counts["d"], "top_issue": max(top, key=top.get) if top else "—"})
        for k, c in (("tot", "n"), ("w", "w"), ("e", "e"), ("d", "d")):
            totals[k] += counts[c]
    totals["ok"] = totals["tot"] - totals["e"] - (totals["d"] if skip_dups else 0)
    migration.dry_run = {"at": datetime.now().isoformat(), "totals": totals, "objects": objects, "issues": issues}
    migration.status = "Dry run passed" if objects else "Draft"
    return migration.dry_run


def error_report(migration: TenantMigration) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Dataset", "Line", "Level", "Issue"])
    for issue in (migration.dry_run or {}).get("issues", []):
        writer.writerow([issue["dataset"], issue["line"], issue["level"], issue["message"]])
    return out.getvalue()


def _set(migration_id: int, **values) -> None:
    db = MasterSessionLocal()
    try:
        db.query(TenantMigration).filter(TenantMigration.id == migration_id).update(values)
        db.commit()
    finally:
        db.close()


def _lock(migration_id: int):
    connection = master_engine.connect()
    if connection.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": f"tenant_migration_{migration_id}"}).scalar() != 1:
        connection.close()
        return None
    return connection


def run_migration(migration_id: int) -> None:
    """Import the mapped datasets (background thread). The job's advisory lock marks it alive across workers."""
    lock = _lock(migration_id)
    if lock is None:
        return
    try:
        _run_migration(migration_id)
    finally:  # pooled connections keep MariaDB session locks, so release explicitly
        lock.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": f"tenant_migration_{migration_id}"})
        lock.close()


def _status(migration_id: int) -> str:
    db = MasterSessionLocal()
    try:
        return db.query(TenantMigration.status).filter(TenantMigration.id == migration_id).scalar()
    finally:
        db.close()


# Tenant table of each target, in the order rollback removes them (dependants first).
TABLES = {"activities": "kam_activities", "quotes": "quotations", "deals": "leads", "leads": "leads", "contacts": "customer_contacts",
          "products": "products_master", "customers": "customers"}
_TAGGED = ("customers", "leads", "deals")  # tables with custom_data: every imported row carries {"import": "MIG-<id>"}


def _empty() -> dict:
    return {"created": {t: [] for t in TARGETS}, "updated": {t: 0 for t in TARGETS}, "skipped": 0, "errors": 0}


def _settle_pending(session, result: dict) -> dict:
    """A batch is recorded as 'pending' before its tenant commit. Decide whether that commit landed (its new rows exist)."""
    pending = result.get("pending")
    if not pending:
        return result
    landed = False
    for target, ids in (pending.get("created") or {}).items():
        new = set(ids) - set((result.get("created") or {}).get(target, []))
        if new and target in TABLES:
            table = TABLES[target]
            landed = bool(session.execute(text(f"SELECT COUNT(*) FROM {table} WHERE id = :i"), {"i": max(new)}).scalar())
            break
    settled = {k: v for k, v in (pending if landed else result).items() if k != "pending"}
    return settled


def _import_row(session, ctx: _Context, target: str, values: dict, dup, rules: dict, migration_id: int, created: dict, updated: dict) -> None:
    """Create (or update, under 'Update existing') one record. Raises nothing for valid rows."""
    from app.core.timezone import now_ist
    from app.models.all_models import Customer, CustomerContact, KAMActivity, Lead, ProductMaster, Quotation, SalesCustomerAssignment
    from app.routers.lead_router import _next_lead_ref_id, _next_opportunity_ref_id
    from app.routers.quotation_router import _next_quotation_number

    update = dup is not None and rules.get("dup", DUPLICATE_RULES[0]) == DUPLICATE_RULES[1]
    owner_id = ctx.owner(rules, values.get("owner_email", ""))
    created_at = _parse_date(values["created_at"]) if rules.get("dates", True) and values.get("created_at") else None
    notes = values.get("notes") if rules.get("notes", True) else None
    tag = {"import": f"MIG-{migration_id}", **({"external_id": values["external_id"]} if rules.get("ids", True) and values.get("external_id") else {})}
    customer_id = ctx.customer_id(values)
    cols = lambda model: {c.key for c in model.__table__.columns}  # noqa: E731

    def finish(model, record, target_key, lookup=None, lookup_key=None):
        if created_at and hasattr(record, "created_at"):
            record.created_at = created_at
        session.add(record)
        session.flush()
        created[target_key].append(record.id)
        if lookup is not None:
            lookup[lookup_key] = record.id
        return record

    if target == "customers":
        data = {k: values[k] for k in ("customer_name", "customer_vertical", "division", "group_name", "billing_address", "billing_city", "billing_state",
                                       "billing_pincode", "billing_country", "gst_number", "pan_number", "website", "account_status",
                                       "account_potential", "remarks") if values.get(k)}
        if values.get("potential_value"):
            data["potential_value"] = _parse_number(values["potential_value"])
        if notes:
            data["remarks"] = f"{data.get('remarks', '')}\n{notes}".strip()
        data = {k: v for k, v in data.items() if k in cols(Customer)}
        if update and dup in ctx.customers:
            session.query(Customer).filter(Customer.id == ctx.customers[dup]).update(data)
            updated[target] += 1
            return
        customer = finish(Customer, Customer(**data, created_by=ctx.admin_id, assigned_to=owner_id, is_active=True, is_deleted=False, approval_status="approved",
                                             **({"custom_data": tag} if "custom_data" in cols(Customer) else {})),
                          target, ctx.customers, values["customer_name"].strip().lower())
        session.add(SalesCustomerAssignment(user_id=owner_id, customer_id=customer.id, assigned_by=ctx.admin_id, is_active=True))
        if values.get("contact_name"):
            session.add(CustomerContact(customer_id=customer.id, contact_name=values["contact_name"][:100], designation=values.get("contact_designation"),
                                        mobile=(values.get("contact_mobile") or "")[:20] or None, office_email=values.get("contact_email"),
                                        is_primary=True, is_active=True, created_by=ctx.admin_id))
    elif target == "products":
        data = {"name": values["name"][:300], "category": (values.get("category") or "")[:100] or None, "description": values.get("description")}
        if update and dup in ctx.products:
            session.query(ProductMaster).filter(ProductMaster.id == ctx.products[dup]).update(data)
            updated[target] += 1
            return
        finish(ProductMaster, ProductMaster(**data, is_active=True), target, ctx.products, values["name"].strip().lower())
    elif target == "contacts":
        data = {"customer_id": customer_id, "contact_name": values["contact_name"][:100], "designation": values.get("designation"),
                "department": values.get("department"), "mobile": (values.get("mobile") or "")[:20] or None,
                "office_phone": (values.get("office_phone") or "")[:20] or None, "office_email": (values.get("office_email") or "")[:100] or None,
                "notes": notes}
        data = {k: v for k, v in data.items() if v is not None}
        if update and dup in ctx.contacts:
            session.query(CustomerContact).filter(CustomerContact.id == ctx.contacts[dup]).update(data)
            updated[target] += 1
            return
        primary = not any(k[0] == customer_id for k in ctx.contacts)
        finish(CustomerContact, CustomerContact(**data, is_primary=primary, is_active=True, created_by=ctx.admin_id), target,
               ctx.contacts, (customer_id, values["contact_name"].strip().lower()))
    elif target in ("leads", "deals"):
        data = {k: values[k] for k in ("lead_title", "customer_name", "contact_person", "designation", "mobile", "email", "priority", "region",
                                       "branch", "product_description") if values.get(k)}
        data["est_value"] = _parse_number(values.get("est_value", "")) or 0
        if customer_id:
            data["customer_id"] = customer_id
        if target == "leads":
            data["status"] = values["status"] if values.get("status") in ctx.lead_statuses else (ctx.lead_statuses[0] if ctx.lead_statuses else "Assigned")
            if notes:
                data["notes"] = notes
        else:
            data["status"] = _deal_status(values.get("stage", ""), ctx.lead_statuses)
            stage = f"Stage in source CRM: {values['stage']}" if values.get("stage") else ""
            data["notes"] = "\n".join(x for x in (stage, notes or "") if x) or None
            close = _parse_date(values.get("close_date", "")) if values.get("close_date") else None
            if close:
                data["timeline"] = close.date()
        data = {k: v for k, v in data.items() if k in cols(Lead)}
        book = ctx.leads if target == "leads" else ctx.deals
        if update and dup in book:
            session.query(Lead).filter(Lead.id == book[dup]).update(data)
            updated[target] += 1
            return
        when = created_at or now_ist()
        extra = {"lead_type": "lead"}
        if target == "deals":
            extra = {"lead_type": "direct_opportunity", "conversion_target": "quotation", "opportunity_created_at": when,
                     "opportunity_ref_id": _next_opportunity_ref_id(session) if data["status"] in ("Opportunity Created", "Converted") else None,
                     **({"lost_at": when} if data["status"] == "Lost" else {})}
        extra = {k: v for k, v in extra.items() if k in cols(Lead)}
        finish(Lead, Lead(**data, **extra, lead_ref_id=_next_lead_ref_id(session), assigned_to=owner_id, created_by=ctx.admin_id, lead_created_at=when,
                          **({"custom_data": tag} if "custom_data" in cols(Lead) else {})),
               target, book, (values["lead_title"].strip().lower(), (values.get("customer_name") or "").strip().lower()))
    elif target == "quotes":
        amount = _parse_number(values.get("amount", "")) or 0
        tax = _parse_number(values.get("tax_amount", "")) or 0
        total = _parse_number(values.get("total_amount", "")) or (amount + tax)
        valid = _parse_date(values.get("valid_until", "")) if values.get("valid_until") else None
        data = {"subject": values["subject"][:500], "customer_id": customer_id, "amount": amount, "tax_amount": tax, "total_amount": total,
                "valid_until": valid.date() if valid else None, "status": _pick(values.get("status", ""), ctx.quote_statuses) or "Draft",
                "notes": notes, "terms_conditions": values.get("terms_conditions"), "ref_number": (values.get("quote_number") or "")[:100] or None,
                "customer_to_name": (values.get("customer_name") or "")[:300] or None}
        data = {k: v for k, v in data.items() if k in cols(Quotation)}
        key = ("ref", (values.get("quote_number") or "").strip().lower()) if values.get("quote_number") else (values["subject"].strip().lower(), customer_id)
        if update and dup is not None:
            existing = ctx.quote_refs.get(dup[1]) if dup[0] == "ref" else ctx.quotes.get(dup)
            if existing:
                session.query(Quotation).filter(Quotation.id == existing).update(data)
                updated[target] += 1
                return
        quote = finish(Quotation, Quotation(**data, quotation_number=_next_quotation_number(session), revision_number=1, created_by=owner_id), target,
                       ctx.quotes, (values["subject"].strip().lower(), customer_id))
        if key[0] == "ref":
            ctx.quote_refs[key[1]] = quote.id
    elif target == "activities":
        day = _parse_date(values["activity_date"])
        status = _pick(values.get("status", ""), ctx.activity_statuses) or ("Completed" if day.date() <= now_ist().date() else "Planned")
        data = {"subject": values["subject"][:300], "activity_type": (values.get("activity_type") or "Follow Up")[:50], "activity_date": day.date(),
                "customer_id": customer_id, "description": "\n".join(x for x in (values.get("description"), notes) if x) or None,
                "status": status, "outcome": values.get("outcome"), "user_id": owner_id}
        data = {k: v for k, v in data.items() if k in cols(KAMActivity)}
        if update and dup in ctx.activities:
            session.query(KAMActivity).filter(KAMActivity.id == ctx.activities[dup]).update(data)
            updated[target] += 1
            return
        finish(KAMActivity, KAMActivity(**data, created_by=ctx.admin_id), target, ctx.activities, (values["subject"].strip().lower(), str(day.date()), customer_id))


def _run_migration(migration_id: int) -> None:
    from app.core.logging import log_module_action

    db = MasterSessionLocal()
    migration = db.get(TenantMigration, migration_id)
    tenant = db.get(Tenant, migration.tenant_id)
    db.close()
    rules = migration.rules or {}
    session = get_tenant_session(tenant.slug)
    state = _empty()
    try:
        previous = _settle_pending(session, migration.result or {})  # a resumed run continues after the last checkpoint
        for key in ("created", "updated"):
            state[key].update({t: v for t, v in (previous.get(key) or {}).items() if t in TARGETS})
        state["skipped"], state["errors"] = int(previous.get("skipped") or 0), int(previous.get("errors") or 0)
        cursor = int(previous.get("cursor") or 0)
        committed = {"cursor": cursor, **json_copy(state)}

        def checkpoint(position: int, **extra) -> None:
            """Record the batch as pending, commit it in the tenant DB, then record it as committed."""
            nonlocal committed
            snapshot = {"cursor": position, **json_copy(state)}
            _set(migration_id, result={**committed, "pending": snapshot})
            session.commit()
            committed = snapshot
            _set(migration_id, result=committed, **extra)

        _set(migration_id, status="Running", progress=max(1, migration.progress or 0), error=None, result=committed)
        ctx = _Context(session, tenant)
        total = max(1, sum(d["rows"] for d, _, _ in mapped(migration)))
        done, seen = 0, set()
        for dataset, target, fields in mapped(migration):
            for row in read_rows(migration, dataset):
                done += 1
                if done <= cursor:
                    _check_row(target, {fields[c]: v for c, v in row.items() if c in fields and v}, ctx, rules, seen)  # rebuild duplicate keys
                    continue  # imported before the pause / interruption
                if done % BATCH == 0:  # rows before this one are done: commit them and record the checkpoint
                    checkpoint(done - 1, progress=min(99, int(done / total * 100)))
                    if _status(migration_id) == "Pausing":
                        _set(migration_id, status="Paused")
                        return
                values = {fields[c]: v for c, v in row.items() if c in fields and v}
                errors, _warnings, dup = _check_row(target, values, ctx, rules, seen)
                if errors:
                    state["errors"] += 1
                    continue
                if dup is not None and rules.get("dup", DUPLICATE_RULES[0]) == DUPLICATE_RULES[0]:
                    state["skipped"] += 1
                    continue
                if dup is not None and rules.get("dup") == DUPLICATE_RULES[2]:
                    dup = None  # "Create anyway"
                _import_row(session, ctx, target, values, dup, rules, migration_id, state["created"], state["updated"])
        checkpoint(done)
        modules = {"customers": "customers", "leads": "leads", "deals": "leads", "contacts": "customers", "products": "products",
                   "quotes": "quotations", "activities": "kam"}
        for target in TARGETS:
            n, u = len(state["created"][target]), state["updated"][target]
            if n or u:
                log_module_action(session, ctx.admin_id, modules[target], "import", None, record_name=f"MIG-{migration_id}",
                                  description=f"{n} {TARGETS[target]['label'].lower()} imported and {u} updated by platform migration MIG-{migration_id} ({migration.source})")
        session.commit()
        drop_staging(migration)
        _set(migration_id, status="Completed", progress=100, completed_at=datetime.now(), staging_db=None, result={**committed, "cursor": None})
    except Exception as exc:
        session.rollback()
        logger.exception("Migration %s failed", migration_id)
        # The current batch was rolled back; any 'pending' record is settled on resume or rollback.
        _set(migration_id, status="Failed", error=str(exc)[:1000])
    finally:
        session.close()


def json_copy(state: dict) -> dict:
    return {"created": {t: list(v) for t, v in state["created"].items()}, "updated": dict(state["updated"]),
            "skipped": state["skipped"], "errors": state["errors"]}


def start_migration(migration_id: int) -> None:
    threading.Thread(target=run_migration, args=(migration_id,), daemon=True, name=f"tenant-migration-{migration_id}").start()


def _lock_free(name: str) -> bool:
    with master_engine.connect() as connection:
        return connection.execute(text("SELECT IS_FREE_LOCK(:n)"), {"n": name}).scalar() == 1


def housekeeping() -> dict:
    """Every minute: start cut-overs that are due, and mark runs / pulls whose worker died as interrupted."""
    db = MasterSessionLocal()
    started, interrupted = [], 0
    try:
        for m in db.query(TenantMigration).filter(TenantMigration.status == "Dry run passed", TenantMigration.scheduled_at.isnot(None),
                                                  TenantMigration.scheduled_at <= datetime.now()).all():
            m.status, m.progress, m.scheduled_at = "Running", m.progress or 0, None
            started.append(m.id)
        for m in db.query(TenantMigration).filter(TenantMigration.status.in_(("Running", "Pausing"))).all():
            if m.id not in started and _lock_free(f"tenant_migration_{m.id}"):
                m.status, m.error = "Interrupted", INTERRUPTED
                interrupted += 1
        settled = datetime.now() - timedelta(minutes=1)  # a just-created pull may not hold its lock yet
        for m in db.query(TenantMigration).filter(TenantMigration.status == "Fetching", TenantMigration.created_at < settled).all():
            if _lock_free(f"tenant_migration_pull_{m.id}"):
                m.status, m.error = "Failed", "The pull from the source was interrupted – start a new migration"
        db.commit()
    finally:
        db.close()
    for migration_id in started:
        start_migration(migration_id)
    return {"started": started, "interrupted": interrupted}


def rollback(migration: TenantMigration, tenant: Tenant) -> dict:
    """Remove what the migration created – a completed one within 7 days, or a partial (paused / interrupted / failed) one."""
    if migration.status not in ("Completed",) + RESUMABLE:
        raise ValueError("Only completed or partially run migrations can be rolled back")
    if migration.completed_at and datetime.now() - migration.completed_at > ROLLBACK_WINDOW:
        raise ValueError("The 7-day rollback window has passed")
    expanding = lambda sql: text(sql).bindparams(bindparam("ids", expanding=True))  # noqa: E731
    session = get_tenant_session(tenant.slug)
    try:
        result = _settle_pending(session, migration.result or {})
        created = {t: list(v) for t, v in (result.get("created") or {}).items()}
        tag = f"MIG-{migration.id}"
        for target in _TAGGED:  # rows committed after the last checkpoint are still found by their import tag
            kind = "AND lead_type = 'direct_opportunity'" if target == "deals" else "AND lead_type <> 'direct_opportunity'" if target == "leads" else ""
            tagged = [r[0] for r in session.execute(text(
                f"SELECT id FROM {TABLES[target]} WHERE JSON_UNQUOTE(JSON_EXTRACT(custom_data, '$.import')) = :tag {kind}"), {"tag": tag}).all()]
            created[target] = sorted(set(created.get(target, [])) | set(tagged))
        counts = {}
        for target, table in TABLES.items():
            ids = created.get(target) or []
            if not ids:
                counts[target] = 0
                continue
            if target == "customers":
                session.execute(expanding("UPDATE leads SET customer_id = NULL WHERE customer_id IN :ids"), {"ids": ids})
                session.execute(expanding("UPDATE quotations SET customer_id = NULL WHERE customer_id IN :ids"), {"ids": ids})
                session.execute(expanding("UPDATE kam_activities SET customer_id = NULL WHERE customer_id IN :ids"), {"ids": ids})
                session.execute(expanding("DELETE FROM sales_customer_assignments WHERE customer_id IN :ids"), {"ids": ids})
                session.execute(expanding("DELETE FROM customer_contacts WHERE customer_id IN :ids"), {"ids": ids})
            counts[target] = session.execute(expanding(f"DELETE FROM {table} WHERE id IN :ids"), {"ids": ids}).rowcount
        session.commit()
    finally:
        session.close()
    migration.status = "Rolled back"
    return counts
