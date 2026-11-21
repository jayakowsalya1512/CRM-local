"""One-off maintenance: force-sync every tenant's system report definitions
(field lists, filters) with the current _SYSTEM_REPORTS spec in
report_engine_router.py, and audit for duplicate non-system reports that
share a system report's name (those duplicates are what the UI opens if a
user "Saved" a copy earlier — they never get touched by the sync, which is
why some reports still show old/minimal columns after resync). Safe to
re-run any time — idempotent.

Run with the same interpreter/venv used to run the backend, e.g.:
    venv\\Scripts\\python.exe resync_system_reports.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from app.models.tenant import Tenant
from app.models.all_models import SavedReport
from app.database import MasterSessionLocal, get_tenant_session
from app.routers.report_engine_router import seed_system_reports, _SYSTEM_REPORTS

db = MasterSessionLocal()
tenants = db.query(Tenant).all()
db.close()

report_names = [spec["name"] for spec in _SYSTEM_REPORTS]
print(f"{len(_SYSTEM_REPORTS)} system report definitions in code.")
print(f"Tenants found: {[t.slug for t in tenants]}\n")

for tenant in tenants:
    session = get_tenant_session(tenant.slug)
    try:
        before_counts = {}
        for name in report_names:
            row = session.query(SavedReport).filter(
                SavedReport.name == name, SavedReport.is_system == True
            ).first()
            before_counts[name] = len((row.config_json or {}).get("fields", [])) if row else None

        created = seed_system_reports(session)
        session.commit()

        print(f"=== {tenant.slug} === ({created} new system report(s) created)")
        any_dupe = False
        for name in report_names:
            after_row = session.query(SavedReport).filter(
                SavedReport.name == name, SavedReport.is_system == True
            ).first()
            after_count = len((after_row.config_json or {}).get("fields", [])) if after_row else None
            dupe_count = session.query(SavedReport).filter(
                SavedReport.name == name, SavedReport.is_system == False
            ).count()
            flag = ""
            if dupe_count:
                any_dupe = True
                flag = f"  <-- {dupe_count} NON-SYSTEM duplicate(s) also named '{name}'"
            print(f"  {name}: {before_counts[name]} -> {after_count} fields{flag}")
        if any_dupe:
            print(
                "\n  NOTE: duplicates flagged above are separate SavedReport rows "
                "(is_system=False) with the same name — likely created earlier via "
                "the report's 'Save' button. The Report Engine list may open one of "
                "those instead of the system report, which is why its columns look "
                "unchanged even after this sync. They are not modified by this "
                "script; rename or delete them from the Reports UI if they're stale."
            )
    except Exception as exc:
        session.rollback()
        print(f"{tenant.slug}: ERROR — {exc}")
    finally:
        session.close()

print("\nDone.")
