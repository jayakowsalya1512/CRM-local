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


conn = pymysql.connect(
    host=get_env("TENANT_DB_HOST", "localhost"),
    port=int(get_env("TENANT_DB_PORT", "3306")),
    user=get_env("TENANT_DB_USER"),
    password=get_env("TENANT_DB_PASSWORD"),
)
cur = conn.cursor()
cur.execute("SHOW DATABASES LIKE 'digitcrm_%'")
dbs = [r[0] for r in cur.fetchall()]
print('Databases found:', dbs)

for db in dbs:
    try:
        # Check existing columns
        cur.execute(f"SHOW COLUMNS FROM `{db}`.`tada_claims`")
        existing = [r[0] for r in cur.fetchall()]
        print(f'{db} existing columns: {existing}')

        cols_to_add = []
        if 'to_city' not in existing:
            cols_to_add.append('ADD COLUMN `to_city` VARCHAR(100) NULL')
        if 'from_city' not in existing:
            cols_to_add.append('ADD COLUMN `from_city` VARCHAR(100) NULL')

        if cols_to_add:
            sql = f"ALTER TABLE `{db}`.`tada_claims` {', '.join(cols_to_add)}"
            cur.execute(sql)
            conn.commit()
            print(f'{db}: Added columns: {cols_to_add}')
        else:
            print(f'{db}: Columns already exist, nothing to do')
    except Exception as e:
        print(f'{db}: ERROR - {e}')

conn.close()
print('Done.')
