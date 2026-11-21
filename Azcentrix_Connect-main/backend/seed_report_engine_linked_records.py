"""
Seed ReportType / ReportTypeField drilldown metadata for the new "Linked Records"
count fields (tender_count, quotation_count, work_order_count, activity_count,
lead_count, opportunity_count) added to the leads / opportunities / tenders /
customers report configs in report_engine_router.py.

Without this metadata the count fields still display correctly (they resolve
via the REPORT_ENGINE_CONFIG fallback in _load_report_runtime_fields), but the
value is not clickable — clicking a count only opens a drilldown once its
ReportTypeField row carries drilldown_kind='report' + drilldown_target +
drilldown_filter_field + drilldown_id_field.

Idempotent and additive only:
  - Never touches any existing ReportType / ReportTypeField row.
  - Get-or-creates the ReportType parent row for a base report type ONLY if
    it doesn't already exist (existing rows for other fields are untouched —
    every other field on that report type keeps resolving through the
    REPORT_ENGINE_CONFIG fallback exactly as it does today).
  - Inserts a ReportTypeField row only when (report_type_id, field_key) has
    no existing row (enforced by the DB's own unique constraint as a backstop).
  - Never deletes or updates an existing row.

Run manually against each tenant DB once, after deploying the config changes:
    python seed_report_engine_linked_records.py            # all active tenants
    python seed_report_engine_linked_records.py --dry-run   # preview only, no writes
    python seed_report_engine_linked_records.py --db digitcrm_acme  # single tenant

Follow up with validate_drilldown_config.py to confirm every row resolves cleanly.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import pymysql
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

env = {}
env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")


def get_env(name, default=""):
    return os.environ.get(name) or env.get(name, default)


DB_HOST = get_env("TENANT_DB_HOST", "localhost")
DB_PORT = int(get_env("TENANT_DB_PORT", "3306"))
DB_USER = get_env("TENANT_DB_USER")
DB_PASSWORD = get_env("TENANT_DB_PASSWORD")

SYSTEM_DBS = {"information_schema", "mysql", "performance_schema", "sys"}


def discover_tenant_dbs() -> list[str]:
    conn = pymysql.connect(host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD)
    cur = conn.cursor()
    cur.execute("SHOW DATABASES")
    all_dbs = [r[0] for r in cur.fetchall()]
    conn.close()
    tenant_dbs = [db for db in all_dbs if db not in SYSTEM_DBS]

    try:
        master_db = env.get("MASTER_DB_NAME") or env.get("DATABASE_NAME") or "saas_platform"
        mconn = pymysql.connect(host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD, db=master_db)
        mcur = mconn.cursor()
        mcur.execute("SELECT db_name FROM tenants WHERE is_active=1")
        rows = mcur.fetchall()
        if rows:
            tenant_dbs = [r[0] for r in rows if r[0] in all_dbs]
        mconn.close()
    except Exception as e:
        print(f"Could not read master DB tenant list, scanning all non-system databases instead: {e}")

    return tenant_dbs


# ---------------------------------------------------------------------------
# What to seed — report_type_key -> base_table, then each new field's
# drilldown wiring. Every (target, filter_field) pair here was verified
# against the actual filter_fields already present (or just added) on the
# target report type before writing this script.
# ---------------------------------------------------------------------------

REPORT_TYPES = {
    "leads":         {"name": "Leads",         "base_table": "leads"},
    "opportunities": {"name": "Opportunities", "base_table": "leads"},
    "tenders":       {"name": "Tenders",       "base_table": "tenders"},
    "customers":     {"name": "Customers",     "base_table": "customers"},
}

# field_key -> (label, drilldown_target, drilldown_filter_field, drilldown_id_field)
LINKED_RECORD_FIELDS: dict[str, dict[str, tuple]] = {
    "leads": {
        "tender_count":     ("Tender Count",     "tender_linkage",    "lead_id", "id"),
        "quotation_count":  ("Quotation Count",  "quotation_linkage", "lead_id", "id"),
        "work_order_count": ("Work Order Count", "workorder_linkage", "lead_id", "id"),
        "activity_count":   ("Activity Count",   "kam_activities",    "lead_id", "id"),
    },
    "opportunities": {
        "tender_count":     ("Tender Count",     "tender_linkage",    "lead_id", "id"),
        "quotation_count":  ("Quotation Count",  "quotation_linkage", "lead_id", "id"),
        "work_order_count": ("Work Order Count", "workorder_linkage", "lead_id", "id"),
        "activity_count":   ("Activity Count",   "kam_activities",    "lead_id", "id"),
    },
    "tenders": {
        "quotation_count":  ("Quotation Count",  "quotation_linkage", "tender_id", "id"),
        "work_order_count": ("Work Order Count", "workorder_linkage", "tender_id", "id"),
        "emdbg_count":      ("EMD/BG Count",      "emdbg_linkage",     "tender_id", "id"),
    },
    "customers": {
        "lead_count":         ("Lead Count",         "lead_linkage",       "customer_id", "id"),
        "opportunity_count":  ("Opportunity Count",  "opportunities",      "customer_id", "id"),
        "tender_count":       ("Tender Count",       "tender_linkage",     "customer_id", "id"),
        "quotation_count":    ("Quotation Count",    "quotation_linkage",  "customer_id", "id"),
        "work_order_count":   ("Work Order Count",   "workorder_linkage",  "customer_id", "id"),
    },
}


def seed_tenant(db_name: str, dry_run: bool) -> None:
    engine_url = f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{db_name}"
    try:
        engine = create_engine(engine_url)
        db = sessionmaker(bind=engine)()
    except Exception as e:
        print(f"  {db_name}: SKIP (cannot connect: {e})")
        return

    from app.models.all_models import ReportType, ReportTypeField  # noqa: E402 (needs sys.path set first)

    try:
        created_types = 0
        created_fields = 0
        skipped_fields = 0

        for rt_key, rt_meta in REPORT_TYPES.items():
            rt_row = db.query(ReportType).filter(ReportType.key == rt_key).first()
            if not rt_row:
                if dry_run:
                    print(f"  {db_name}: would create ReportType '{rt_key}'")
                else:
                    rt_row = ReportType(
                        key=rt_key,
                        name=rt_meta["name"],
                        base_table=rt_meta["base_table"],
                        is_active=True,
                    )
                    db.add(rt_row)
                    db.flush()
                    created_types += 1

            for field_key, (label, target, filter_field, id_field) in LINKED_RECORD_FIELDS[rt_key].items():
                existing = None
                if rt_row and rt_row.id:
                    existing = (
                        db.query(ReportTypeField)
                        .filter(ReportTypeField.report_type_id == rt_row.id, ReportTypeField.field_key == field_key)
                        .first()
                    )
                if existing:
                    skipped_fields += 1
                    continue

                if dry_run:
                    print(f"  {db_name}: would add {rt_key}.{field_key} -> drilldown to {target}[{filter_field}]")
                    continue

                db.add(ReportTypeField(
                    report_type_id=rt_row.id,
                    field_key=field_key,
                    label=label,
                    data_type="number",
                    is_default_column=False,
                    is_filterable=False,
                    is_groupable=False,
                    is_sortable=True,
                    is_aggregatable=True,
                    drilldown_kind="report",
                    drilldown_target=target,
                    drilldown_id_field=id_field,
                    drilldown_filter_field=filter_field,
                ))
                created_fields += 1

        if dry_run:
            print(f"  {db_name}: dry run complete — no changes written")
        else:
            db.commit()
            print(f"  {db_name}: created {created_types} report type(s), {created_fields} field(s), skipped {skipped_fields} already-present field(s)")
    except Exception as e:
        db.rollback()
        print(f"  {db_name}: FAILED ({e}) — rolled back, no partial writes")
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    parser.add_argument("--db", help="Seed a single tenant database by name instead of discovering all")
    args = parser.parse_args()

    tenant_dbs = [args.db] if args.db else discover_tenant_dbs()
    if not tenant_dbs:
        print("No tenant databases found.")
        return

    print(f"Seeding Linked Records drilldown metadata for {len(tenant_dbs)} tenant(s){' (DRY RUN)' if args.dry_run else ''}:")
    for db_name in tenant_dbs:
        seed_tenant(db_name, args.dry_run)


if __name__ == "__main__":
    main()
