"""
Debug script — run from D:\saas-crm\backend to trace why scoping fails.

Usage:
    cd D:\saas-crm\backend
    python debug_scoping.py <username>

Example:
    python debug_scoping.py manager1
"""
import sys
import os

# ── Add backend to path ───────────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.database import get_tenant_session_by_db_name
from app.models.all_models import User, Group

# ── CONFIG — change these to match your setup ─────────────────────────────────
TENANT_DB_NAME = "digitcrm_ascent"   # ← your tenant DB name (check app/database.py or .env)
TEST_USERNAME  = sys.argv[1] if len(sys.argv) > 1 else "manager1"
# ─────────────────────────────────────────────────────────────────────────────

try:
    db = get_tenant_session_by_db_name(TENANT_DB_NAME)
except Exception as e:
    print(f"ERROR connecting to tenant DB '{TENANT_DB_NAME}': {e}")
    print("Edit TENANT_DB_NAME at the top of this script to match your DB.")
    sys.exit(1)

print(f"\n{'='*60}")
print(f"SCOPING DEBUG for user: {TEST_USERNAME}")
print(f"{'='*60}\n")

# ── 1. Find the user ──────────────────────────────────────────────────────────
cu = db.query(User).filter(User.username == TEST_USERNAME).first()
if not cu:
    print(f"ERROR: User '{TEST_USERNAME}' not found in DB.")
    print("Available users:")
    for u in db.query(User).filter(User.is_active == True).all():
        print(f"  id={u.id}  username={u.username}  role={u.role}  group_id={u.group_id}  reporting_manager_id={u.reporting_manager_id}")
    sys.exit(1)

print(f"User found:")
print(f"  id                   = {cu.id}")
print(f"  username             = {cu.username}")
print(f"  full_name            = {cu.full_name}")
print(f"  role                 = {cu.role}")
print(f"  group_id             = {cu.group_id}")
print(f"  reporting_manager_id = {cu.reporting_manager_id}")

# ── 2. Step 1: direct reports ─────────────────────────────────────────────────
print(f"\n{'─'*40}")
print("STEP 1: Direct reports (User.reporting_manager_id == cu.id)")
direct = db.query(User).filter(
    User.reporting_manager_id == cu.id, User.is_active == True
).all()
if direct:
    for u in direct:
        print(f"  ✓ id={u.id}  username={u.username}  role={u.role}  group_id={u.group_id}")
else:
    print("  ✗ NONE — no users have this user as reporting_manager_id")
    print("    This is the likely problem!")
    print("    Sales users were probably created WITHOUT a group, so")
    print("    _resolve_reporting_manager() set reporting_manager_id=None")

# ── 3. Step 2: group membership ───────────────────────────────────────────────
print(f"\n{'─'*40}")
print("STEP 2: Groups where Group.manager_id == cu.id")
my_groups = db.query(Group).filter(
    Group.manager_id == cu.id, Group.is_active == True
).all()
if my_groups:
    for g in my_groups:
        print(f"  ✓ Group id={g.id}  name={g.name}")
        members = db.query(User).filter(
            User.group_id == g.id, User.is_active == True
        ).all()
        if members:
            for u in members:
                print(f"      member: id={u.id}  username={u.username}  role={u.role}  reporting_manager_id={u.reporting_manager_id}")
        else:
            print(f"      ✗ NO MEMBERS with User.group_id = {g.id}")
            print(f"        Users exist in DB with this group? Let's check ALL users...")
            all_with_group = db.query(User).filter(User.group_id == g.id).all()
            if all_with_group:
                for u in all_with_group:
                    print(f"        (inactive?) id={u.id}  username={u.username}  is_active={u.is_active}")
            else:
                print(f"        NO users at all have group_id={g.id}")
                print(f"        → Sales users were NOT assigned to this group when created")
else:
    print("  ✗ NONE — this user is not set as manager_id in any Group")
    print("    Go to Masters → Groups and set this user as the group head")

# ── 4. Show all users and their group assignments ─────────────────────────────
print(f"\n{'─'*40}")
print("ALL ACTIVE USERS in the system (to diagnose assignment gaps):")
all_users = db.query(User).filter(User.is_active == True).order_by(User.role, User.id).all()
for u in all_users:
    grp_name = ""
    if u.group_id:
        g = db.query(Group).filter(Group.id == u.group_id).first()
        grp_name = g.name if g else f"(group {u.group_id} not found)"
    mgr_name = ""
    if u.reporting_manager_id:
        m = db.query(User).filter(User.id == u.reporting_manager_id).first()
        mgr_name = m.username if m else f"(user {u.reporting_manager_id} not found)"
    print(f"  id={u.id:3}  role={u.role:10}  username={u.username:20}  group={grp_name:20}  reports_to={mgr_name}")

# ── 5. Show all groups ────────────────────────────────────────────────────────
print(f"\n{'─'*40}")
print("ALL GROUPS:")
all_groups = db.query(Group).filter(Group.is_active == True).all()
if all_groups:
    for g in all_groups:
        mgr = db.query(User).filter(User.id == g.manager_id).first() if g.manager_id else None
        member_count = db.query(User).filter(User.group_id == g.id, User.is_active == True).count()
        print(f"  Group id={g.id}  name={g.name}  manager={mgr.username if mgr else 'NONE'}  members={member_count}")
else:
    print("  NO GROUPS found in the database!")

# ── 6. Run actual get_team_ids ────────────────────────────────────────────────
print(f"\n{'─'*40}")
print("Running get_team_ids() from scoping.py:")
try:
    from app.services.scoping import get_team_ids
    team_ids = get_team_ids(db, cu)
    print(f"  Result: {team_ids}")
    if len(team_ids) <= 1:
        print("  ⚠ Only 1 ID (just the user themselves) — scoping is NOT working")
    else:
        print(f"  ✓ {len(team_ids)} users in scope")
        for uid in team_ids:
            u = db.query(User).filter(User.id == uid).first()
            if u:
                print(f"    id={u.id}  username={u.username}  role={u.role}")
except Exception as e:
    print(f"  ERROR running get_team_ids: {e}")

print(f"\n{'='*60}")
print("DIAGNOSIS SUMMARY")
print(f"{'='*60}")
print("""
Most likely causes if only 1 ID returned:

  CAUSE A — Sales users have group_id = NULL
    Fix: Go to Settings → Users, edit each sales user,
         assign them to the correct group.
         This triggers _resolve_reporting_manager() which sets
         reporting_manager_id = Group.manager_id automatically.

  CAUSE B — This user is not set as Group.manager_id
    Fix: Go to Masters → Groups, edit the group,
         set this VP/manager user as the group head.

  CAUSE C — Users were created before the group existed
    Fix: Re-save each sales user with their group assigned.
         The PUT /auth/users/{id} endpoint will call
         _resolve_reporting_manager() and fix the FK.

  CAUSE D — scoping.py is still the OLD version on disk
    Fix: Verify D:\\saas-crm\\backend\\app\\services\\scoping.py
         contains the get_team_ids() function with Step 1/2/3.
""")

db.close()