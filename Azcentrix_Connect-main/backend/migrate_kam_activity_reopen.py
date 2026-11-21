"""
Migration: KAM activity audit / GPS-history / manager-reopen workflow.
Run ON THE SERVER, same way as migrate_conversion_target.py (double-click a
.bat wrapper, or `python migrate_kam_activity_reopen.py`).

What this does, per tenant database:
  1. Adds 'Reopened' to kam_activities.status and the 4 reopen-tracking
     columns (current_cycle_no, reopen_count, last_reopened_at, last_reopened_by).
  2. Creates kam_log (combined event + GPS audit trail) and
     kam_activity_execution_cycles if they don't already exist.
  3. Backfills exactly one execution-cycle row (cycle 1) and one
     LEGACY_ACTIVITY_MIGRATED kam_log row per existing kam_activities row
     that doesn't have a cycle yet.

Safe to re-run: every step is idempotent — schema changes use
IF NOT EXISTS / CREATE TABLE IF NOT EXISTS, and the backfill only inserts
a cycle for activities that don't already have one.

NOTE ON TABLE LOCKS: step 1's ADD COLUMN statements and the enum MODIFY
briefly take a metadata lock on kam_activities. On MySQL 8.0.12+, appending
a new value to the end of an ENUM and adding columns with an explicit
default are both "instant" DDL operations (no table rebuild, no full-table
lock) — but on older MySQL/MariaDB versions or with STRICT replication
setups, these can escalate to a full table copy and lock reads/writes for
the duration. Run during a maintenance window if any tenant DB is on
MySQL < 8.0.12 or is MariaDB.
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
    except Exception:
        pass

if not conn:
    print("ERROR: Cannot connect to MySQL.")
    print("Please run this SQL manually against each tenant database instead — see")
    print("the module docstring in this file for the full statement list.")
    input("\nPress Enter to exit...")
    exit(1)

SCHEMA_STATEMENTS = [
    "ALTER TABLE kam_activities "
    "MODIFY COLUMN status ENUM('Planned','In Progress','Completed','Cancelled','Postponed','Reopened') NULL",

    "ALTER TABLE kam_activities "
    "ADD COLUMN IF NOT EXISTS current_cycle_no INT NOT NULL DEFAULT 1, "
    "ADD COLUMN IF NOT EXISTS reopen_count INT NOT NULL DEFAULT 0, "
    "ADD COLUMN IF NOT EXISTS last_reopened_at DATETIME NULL, "
    "ADD COLUMN IF NOT EXISTS last_reopened_by INT NULL",

    """
    CREATE TABLE IF NOT EXISTS kam_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        activity_id INT NOT NULL,
        cycle_no INT NOT NULL DEFAULT 1,
        event_type VARCHAR(60) NOT NULL,
        previous_status VARCHAR(30) NULL,
        new_status VARCHAR(30) NULL,
        actor_user_id INT NULL,
        actor_role VARCHAR(50) NULL,
        reason VARCHAR(500) NULL,
        remarks TEXT NULL,
        old_values_json JSON NULL,
        new_values_json JSON NULL,
        metadata_json JSON NULL,
        latitude DECIMAL(10,7) NULL,
        longitude DECIMAL(10,7) NULL,
        accuracy_meters DECIMAL(10,2) NULL,
        address VARCHAR(500) NULL,
        locality VARCHAR(150) NULL,
        district VARCHAR(150) NULL,
        state VARCHAR(150) NULL,
        postal_code VARCHAR(20) NULL,
        permission_status VARCHAR(30) NULL,
        is_mock_location TINYINT(1) NOT NULL DEFAULT 0,
        capture_source VARCHAR(30) NULL,
        client_event_at DATETIME NULL,
        event_at DATETIME NOT NULL,
        source VARCHAR(30) NULL,
        device_id VARCHAR(255) NULL,
        ip_address VARCHAR(45) NULL,
        request_id VARCHAR(100) NULL,
        idempotency_key VARCHAR(100) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_kam_log_activity_idem (activity_id, idempotency_key),
        KEY ix_kam_log_activity_time (activity_id, event_at),
        KEY ix_kam_log_actor_time (actor_user_id, event_at),
        KEY ix_kam_log_event_type (event_type),
        KEY ix_kam_log_activity_cycle (activity_id, cycle_no),
        KEY ix_kam_log_activity_location (activity_id, latitude, longitude),
        CONSTRAINT fk_kam_log_activity FOREIGN KEY (activity_id) REFERENCES kam_activities(id) ON DELETE RESTRICT,
        CONSTRAINT fk_kam_log_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,

    """
    CREATE TABLE IF NOT EXISTS kam_activity_execution_cycles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        activity_id INT NOT NULL,
        cycle_no INT NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'Open',
        opened_at DATETIME NOT NULL,
        opened_by INT NULL,
        open_reason TEXT NULL,
        started_at DATETIME NULL,
        started_by INT NULL,
        completed_at DATETIME NULL,
        completed_by INT NULL,
        completion_notes TEXT NULL,
        completion_outcome TEXT NULL,
        actual_duration_minutes INT NULL,
        reopened_at DATETIME NULL,
        reopened_by INT NULL,
        reopen_reason TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_kam_activity_cycle_no (activity_id, cycle_no),
        KEY ix_kam_activity_cycle_status (activity_id, status),
        CONSTRAINT fk_kam_cycle_activity FOREIGN KEY (activity_id) REFERENCES kam_activities(id) ON DELETE RESTRICT,
        CONSTRAINT fk_kam_cycle_opened_by FOREIGN KEY (opened_by) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_kam_cycle_started_by FOREIGN KEY (started_by) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_kam_cycle_completed_by FOREIGN KEY (completed_by) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_kam_cycle_reopened_by FOREIGN KEY (reopened_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
]

# Maps kam_activities.status -> execution-cycle status per the agreed backfill rules.
CYCLE_STATUS_FOR = {
    "Completed": "Completed",
    "Cancelled": "Cancelled",
    "Postponed": "Postponed",
    "In Progress": "In Progress",
}


def backfill_tenant(cur, db_name):
    cur.execute(
        "SELECT id, status, outcome, created_at, updated_at, created_by, user_id, user_role "
        "FROM kam_activities WHERE id NOT IN ("
        "  SELECT DISTINCT activity_id FROM kam_activity_execution_cycles"
        ")"
    )
    rows = cur.fetchall()
    if not rows:
        print(f"  {db_name}: no legacy activities to backfill")
        return 0

    n = 0
    for (act_id, act_status, outcome, created_at, updated_at, created_by, user_id, user_role) in rows:
        cycle_status = CYCLE_STATUS_FOR.get(act_status, "Open")
        opened_by = created_by or user_id
        completed_at = completed_by = completion_outcome = None
        started_at = None
        if cycle_status == "Completed":
            completed_at = updated_at or created_at
            completed_by = user_id or created_by
            completion_outcome = outcome
        elif cycle_status == "In Progress":
            started_at = created_at

        cur.execute(
            "INSERT INTO kam_activity_execution_cycles "
            "(activity_id, cycle_no, status, opened_at, opened_by, started_at, "
            " completed_at, completed_by, completion_outcome) "
            "VALUES (%s, 1, %s, %s, %s, %s, %s, %s, %s)",
            (act_id, cycle_status, created_at, opened_by, started_at,
             completed_at, completed_by, completion_outcome),
        )
        cur.execute(
            "INSERT IGNORE INTO kam_log "
            "(activity_id, cycle_no, event_type, new_status, actor_user_id, actor_role, "
            " source, event_at, idempotency_key) "
            "VALUES (%s, 1, 'LEGACY_ACTIVITY_MIGRATED', %s, %s, %s, 'system', %s, %s)",
            (act_id, act_status, opened_by, user_role, created_at, f"legacy-migrated-{act_id}"),
        )
        n += 1
    return n


cur = conn.cursor()
cur.execute("SHOW DATABASES")
all_dbs = [r[0] for r in cur.fetchall()]

system_dbs = {'information_schema', 'mysql', 'performance_schema', 'sys'}
tenant_dbs = [db for db in all_dbs if db not in system_dbs]
print(f"Databases: {tenant_dbs}\n")

fixed = 0
for db_name in tenant_dbs:
    try:
        cur.execute(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES "
            "WHERE TABLE_SCHEMA=%s AND TABLE_NAME='kam_activities'", (db_name,)
        )
        if not cur.fetchone()[0]:
            continue

        cur.execute(f"USE `{db_name}`")

        for stmt in SCHEMA_STATEMENTS:
            cur.execute(stmt)
        conn.commit()

        backfilled = backfill_tenant(cur, db_name)
        conn.commit()

        print(f"  {db_name}: schema OK, {backfilled} activity(ies) backfilled into cycle 1")
        fixed += 1

    except Exception as e:
        conn.rollback()
        print(f"  {db_name}: ERROR — {e}")

conn.close()
print(f"\nDone. {fixed} database(s) processed.")
input("Press Enter to exit...")
