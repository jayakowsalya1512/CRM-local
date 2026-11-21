import json
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


NEW_FIELDS = [
    "lead_title", "customer_name", "quotation_status", "quotation_amount",
    "work_order_status", "work_order_value", "quotation_number",
    "work_order_number", "created_at",
]

conn = pymysql.connect(
    host=get_env("TENANT_DB_HOST", "localhost"),
    port=int(get_env("TENANT_DB_PORT", "3306")),
    user=get_env("TENANT_DB_USER"),
    password=get_env("TENANT_DB_PASSWORD"),
)
cur = conn.cursor()
cur.execute("SHOW DATABASES LIKE 'digitcrm_%'")
dbs = [r[0] for r in cur.fetchall()]
print("Databases found:", dbs)

for db in dbs:
    try:
        cur.execute(
            f"SELECT id, config_json FROM `{db}`.`saved_reports` "
            f"WHERE name = 'Accepted Quotations to Work Orders'"
        )
        rows = cur.fetchall()
        if not rows:
            print(f"{db}: no matching saved report, skipping")
            continue

        for row_id, config_raw in rows:
            config = json.loads(config_raw) if isinstance(config_raw, str) else (config_raw or {})
            old_fields = config.get("fields")
            config["fields"] = NEW_FIELDS
            cur.execute(
                f"UPDATE `{db}`.`saved_reports` SET config_json = %s WHERE id = %s",
                (json.dumps(config), row_id),
            )
            print(f"{db}: id={row_id} fields {old_fields} -> {NEW_FIELDS}")

        conn.commit()
    except Exception as e:
        print(f"{db}: ERROR - {e}")

cur.close()
conn.close()
print("Done.")
