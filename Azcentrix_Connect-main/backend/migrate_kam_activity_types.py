"""
Migration: normalize kam_activities.activity_type to the new canonical values.

New stored values:
- Phone Call
- Video Call
- In Person Meet
- Demo
- Site Visit
- Follow Up
- Email
"""

import os

import pymysql

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


db_host = get_env("TENANT_DB_HOST", "localhost")
db_port = int(get_env("TENANT_DB_PORT", "3306"))
db_user = get_env("TENANT_DB_USER")
db_password = get_env("TENANT_DB_PASSWORD")

hosts = [db_host]
if db_host in {"localhost", "127.0.0.1"}:
    hosts = ["localhost", "127.0.0.1"]

configs = [
    dict(host=host, port=db_port, user=db_user, password=db_password)
    for host in hosts
]

conn = None
for cfg in configs:
    try:
        conn = pymysql.connect(**cfg)
        print(f"Connected: {cfg['user']}@{cfg['host']} (password={'yes' if cfg['password'] else 'none'})")
        break
    except Exception:
        pass

if not conn:
    print("ERROR: Cannot connect to MySQL.")
    print("Please run the migration SQL manually in each tenant database.")
    print()
    print("1. ALTER TABLE `kam_activities` MODIFY COLUMN `activity_type` VARCHAR(100) NOT NULL DEFAULT 'Phone Call';")
    print("2. Update legacy values:")
    print("   - Daily Call -> Phone Call / Video Call")
    print("   - Meeting -> In Person Meet")
    print("   - Follow-up / Task / Proposal -> Follow Up")
    print("   - Presentation -> Demo")
    input("\nPress Enter to exit...")
    raise SystemExit(1)

cur = conn.cursor()
cur.execute("SHOW DATABASES")
all_dbs = [r[0] for r in cur.fetchall()]

system_dbs = {"information_schema", "mysql", "performance_schema", "sys"}
tenant_dbs = [db for db in all_dbs if db not in system_dbs]
print(f"Databases: {tenant_dbs}\n")

ALTER_SQL = """
ALTER TABLE `kam_activities`
MODIFY COLUMN `activity_type` VARCHAR(100) NOT NULL DEFAULT 'Phone Call'
"""

UPDATE_SQLS = [
    """
    UPDATE `kam_activities`
    SET `activity_type` = 'Video Call'
    WHERE `activity_type` = 'Daily Call' AND `mode` = 'Video Call'
    """,
    """
    UPDATE `kam_activities`
    SET `activity_type` = 'Phone Call'
    WHERE `activity_type` = 'Daily Call'
    """,
    """
    UPDATE `kam_activities`
    SET `activity_type` = 'In Person Meet'
    WHERE `activity_type` = 'Meeting'
    """,
    """
    UPDATE `kam_activities`
    SET `activity_type` = 'Follow Up'
    WHERE `activity_type` IN ('Follow-up', 'Task', 'Proposal')
    """,
    """
    UPDATE `kam_activities`
    SET `activity_type` = 'Demo'
    WHERE `activity_type` = 'Presentation'
    """,
    """
    UPDATE `kam_activities`
    SET `mode` = 'Phone'
    WHERE `activity_type` IN ('Phone Call', 'Follow Up')
      AND (`mode` IS NULL OR TRIM(`mode`) = '')
    """,
    """
    UPDATE `kam_activities`
    SET `mode` = 'Video Call'
    WHERE `activity_type` = 'Video Call'
      AND (`mode` IS NULL OR TRIM(`mode`) = '')
    """,
    """
    UPDATE `kam_activities`
    SET `mode` = 'In-Person'
    WHERE `activity_type` IN ('In Person Meet', 'Demo', 'Site Visit')
      AND (`mode` IS NULL OR TRIM(`mode`) = '')
    """,
    """
    UPDATE `kam_activities`
    SET `mode` = 'Email'
    WHERE `activity_type` = 'Email'
      AND (`mode` IS NULL OR TRIM(`mode`) = '')
    """,
]

updated = 0
for db_name in tenant_dbs:
    try:
        cur.execute(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES "
            "WHERE TABLE_SCHEMA=%s AND TABLE_NAME='kam_activities'",
            (db_name,),
        )
        if not cur.fetchone()[0]:
            continue

        cur.execute(f"USE `{db_name}`")
        cur.execute(ALTER_SQL)
        for sql in UPDATE_SQLS:
            cur.execute(sql)
        conn.commit()
        print(f"  {db_name}: kam_activities normalized")
        updated += 1
    except Exception as exc:
        print(f"  {db_name}: ERROR - {exc}")

conn.close()
print(f"\nDone. {updated} database(s) updated.")
input("Press Enter to exit...")
