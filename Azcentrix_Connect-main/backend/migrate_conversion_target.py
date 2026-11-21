"""
Migration: Add conversion_target column to leads table in all tenant DBs.
Run ON THE SERVER by double-clicking RUN_MIGRATION_ON_SERVER.bat
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

CONFIGS = [
    dict(host=host, port=db_port, user=db_user, password=db_password)
    for host in hosts
]

conn = None
for cfg in CONFIGS:
    try:
        conn = pymysql.connect(**cfg)
        print(f"Connected: {cfg['user']}@{cfg['host']} (password={'yes' if cfg['password'] else 'none'})")
        break
    except Exception as e:
        pass

if not conn:
    print("ERROR: Cannot connect to MySQL.")
    print("Please run this SQL manually in phpMyAdmin on each tenant database:")
    print()
    print("  ALTER TABLE `leads` ADD COLUMN IF NOT EXISTS `conversion_target` VARCHAR(30) NULL;")
    input("\nPress Enter to exit...")
    exit(1)

cur = conn.cursor()
cur.execute("SHOW DATABASES")
all_dbs = [r[0] for r in cur.fetchall()]

system_dbs = {'information_schema', 'mysql', 'performance_schema', 'sys'}
tenant_dbs = [db for db in all_dbs if db not in system_dbs]
print(f"Databases: {tenant_dbs}\n")

ALTER_SQL = (
    "ALTER TABLE `leads` "
    "ADD COLUMN `conversion_target` VARCHAR(30) NULL "
    "COMMENT 'Chosen conversion path: tender or quotation'"
)

fixed = 0
for db_name in tenant_dbs:
    try:
        cur.execute(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES "
            "WHERE TABLE_SCHEMA=%s AND TABLE_NAME='leads'", (db_name,)
        )
        if not cur.fetchone()[0]:
            continue

        cur.execute(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS "
            "WHERE TABLE_SCHEMA=%s AND TABLE_NAME='leads' AND COLUMN_NAME='conversion_target'",
            (db_name,)
        )
        if cur.fetchone()[0]:
            print(f"  {db_name}: already exists — skipped")
            continue

        cur.execute(f"USE `{db_name}`")
        cur.execute(ALTER_SQL)
        conn.commit()
        print(f"  {db_name}: conversion_target ADDED OK")
        fixed += 1

    except Exception as e:
        print(f"  {db_name}: ERROR — {e}")

conn.close()
print(f"\nDone. {fixed} database(s) updated.")
input("Press Enter to exit...")
