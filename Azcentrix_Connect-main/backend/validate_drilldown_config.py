"""
Validate report_type_fields.drilldown_* configuration across all tenant DBs.

Checks every field row where drilldown_kind IS NOT NULL against the rules the
report engine relies on at click-time, so a bad row is caught here instead of
failing silently (or worse, resolving to the wrong record) in the UI:

Policy: report drilldown never leaves the Report Engine. There is no detail/
360/edit-form navigation path — drilldown_kind must always be 'report'. Any
other value (e.g. a legacy/stray 'detail') is flagged here as invalid, and
the frontend independently treats anything other than 'report' as plain,
non-clickable text — so a bad row can't silently resurrect the old
navigate-to-a-form behavior.

1. drilldown_kind must be 'report'.
2. drilldown_id_field must exist as a field_key on the SAME report type, and
   must be resolvable through the normal field-expression mechanism (i.e. it
   would actually appear in _load_report_runtime_fields' select_fields dict).
3. drilldown_target must be an existing, active report type.
4. drilldown_filter_field must exist as a FILTERABLE field on that target
   report type.

Read-only — this script never writes to the database. Exits 0 if every
tenant's config is clean, 1 if any issue was found.
"""

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

conn = pymysql.connect(host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD)
cur = conn.cursor()
cur.execute("SHOW DATABASES")
all_dbs = [r[0] for r in cur.fetchall()]
conn.close()

SYSTEM_DBS = {"information_schema", "mysql", "performance_schema", "sys"}
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

from app.models.all_models import ReportType, ReportTypeField  # noqa: E402
from app.routers.report_engine_router import (  # noqa: E402
    REPORT_ENGINE_CONFIG,
    _load_report_runtime_fields,
)

any_issue = False

for db_name in tenant_dbs:
    engine_url = f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{db_name}"
    try:
        engine = create_engine(engine_url)
        db = sessionmaker(bind=engine)()
    except Exception as e:
        print(f"  {db_name}: SKIP (cannot connect: {e})")
        continue

    try:
        rows = (
            db.query(ReportTypeField, ReportType)
            .join(ReportType, ReportType.id == ReportTypeField.report_type_id)
            .filter(ReportTypeField.drilldown_kind.isnot(None))
            .all()
        )
    except Exception as e:
        print(f"  {db_name}: SKIP (no report_type_fields / drilldown columns yet: {e})")
        db.close()
        continue

    if not rows:
        print(f"  {db_name}: no drilldown-configured fields — nothing to check")
        db.close()
        continue

    print(f"  {db_name}: checking {len(rows)} drilldown-configured field(s)")

    for field, rt in rows:
        label = f"{rt.key}.{field.field_key}"
        issues = []

        if field.drilldown_kind != "report":
            issues.append(
                f"drilldown_kind='{field.drilldown_kind}' is not allowed — only 'report' is permitted "
                f"(report drilldown must never leave the Report Engine)"
            )

        try:
            _, select_fields, filter_fields = _load_report_runtime_fields(rt.key, db)
        except Exception as e:
            issues.append(f"could not load field catalog for report type '{rt.key}': {e}")
            select_fields, filter_fields = {}, {}

        if not field.drilldown_id_field:
            issues.append("drilldown_id_field is required whenever drilldown_kind is set")
        elif field.drilldown_id_field not in select_fields:
            issues.append(
                f"drilldown_id_field='{field.drilldown_id_field}' is not a resolvable field_key on '{rt.key}'"
            )

        if field.drilldown_kind == "report":
            target_rt = (
                db.query(ReportType)
                .filter(ReportType.key == field.drilldown_target, ReportType.is_active.is_(True))
                .first()
            )
            if not target_rt and field.drilldown_target not in REPORT_ENGINE_CONFIG:
                issues.append(f"drilldown_target='{field.drilldown_target}' is not a known/active report type")
            else:
                try:
                    _, _, target_filters = _load_report_runtime_fields(field.drilldown_target, db)
                except Exception as e:
                    target_filters = {}
                    issues.append(f"could not load target report type '{field.drilldown_target}': {e}")
                if field.drilldown_filter_field not in target_filters:
                    issues.append(
                        f"drilldown_filter_field='{field.drilldown_filter_field}' is not a filterable "
                        f"field on target report type '{field.drilldown_target}'"
                    )

        if issues:
            any_issue = True
            print(f"    FAIL  {label}")
            for issue in issues:
                print(f"          - {issue}")
        else:
            print(f"    OK    {label}  -> {field.drilldown_kind}:{field.drilldown_target}")

    db.close()

print()
if any_issue:
    print("Drilldown config validation FAILED — see FAIL lines above.")
    sys.exit(1)
else:
    print("Drilldown config validation passed for all tenants.")
    sys.exit(0)
