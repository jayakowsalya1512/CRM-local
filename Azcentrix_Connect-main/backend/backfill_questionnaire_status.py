"""One-off maintenance: fix CustomerQuestionnaire rows whose status is stuck at
"in_progress"/"reopened" even though completed_questions == total_questions
(100% answered). This happened because _recalc_progress() in
questionnaire_router.py only ever promoted not_started -> in_progress and
never auto-completed a questionnaire once every question was answered
(completing normally required a separate explicit /complete call that the
main answering flow never made). That auto-completion has since been added
to _recalc_progress(), but existing rows created before the fix need a
one-time backfill. Safe to re-run any time -- idempotent.

Run with the same interpreter/venv used to run the backend, e.g.:
    venv\\Scripts\\python.exe backfill_questionnaire_status.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from app.models.tenant import Tenant
from app.models.all_models import CustomerQuestionnaire
from app.database import MasterSessionLocal, get_tenant_session

db = MasterSessionLocal()
tenants = db.query(Tenant).all()
db.close()

print(f"Tenants found: {[t.slug for t in tenants]}\n")

for tenant in tenants:
    session = get_tenant_session(tenant.slug)
    try:
        stuck = (
            session.query(CustomerQuestionnaire)
            .filter(
                CustomerQuestionnaire.status.in_(["in_progress", "reopened"]),
                CustomerQuestionnaire.total_questions > 0,
                CustomerQuestionnaire.completed_questions == CustomerQuestionnaire.total_questions,
            )
            .all()
        )
        for cq in stuck:
            cq.status = "completed"
            cq.completed_at = cq.completed_at or cq.last_saved_at
        session.commit()
        print(f"{tenant.slug}: {len(stuck)} questionnaire(s) fixed")
    except Exception as exc:
        session.rollback()
        print(f"{tenant.slug}: ERROR - {exc}")
    finally:
        session.close()

print("\nDone.")
