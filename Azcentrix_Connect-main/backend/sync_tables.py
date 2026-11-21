"""Run create_all on all tenant DBs to create any missing tables."""
import os
import sys
sys.path.insert(0, r'\\192.168.11.31\d\saas-crm\backend')

import pymysql
from sqlalchemy import create_engine

# Read env
env = {}
env_path = os.path.join(os.path.dirname(__file__), ".env")
with open(env_path) as f:
    for line in f:
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()


def get_env(name, default=""):
    return os.environ.get(name) or env.get(name, default)

host = get_env('TENANT_DB_HOST', 'localhost')
port = int(get_env('TENANT_DB_PORT', 3306))
user = get_env('TENANT_DB_USER')
password = get_env('TENANT_DB_PASSWORD')
prefix = get_env('TENANT_DB_PREFIX', 'digitcrm_')

# Find tenant databases — also check without prefix (like operation_team_beta)
conn = pymysql.connect(host=host, port=port, user=user, password=password)
cur = conn.cursor()
cur.execute("SHOW DATABASES")
all_dbs = [r[0] for r in cur.fetchall()]
conn.close()

print("All databases:", all_dbs)

# Also check master DB for tenant slugs
try:
    master_db = env.get('MASTER_DB_NAME') or env.get('DATABASE_NAME') or 'saas_platform'
    conn2 = pymysql.connect(host=host, port=port, user=user, password=password, db=master_db)
    cur2 = conn2.cursor()
    cur2.execute("SELECT db_name FROM tenants WHERE is_active=1")
    tenant_dbs = [r[0] for r in cur2.fetchall()]
    conn2.close()
    print("Tenant DBs from master:", tenant_dbs)
except Exception as e:
    print(f"Could not read master DB: {e}")
    # Fall back: use all non-system databases
    tenant_dbs = [db for db in all_dbs if db not in ('information_schema', 'mysql', 'performance_schema', 'sys')]
    print("Using fallback tenant DBs:", tenant_dbs)

# Import TenantBase with all models registered
from app.models.all_models import *  # noqa — registers all models with TenantBase
from app.database import TenantBase

for db_name in tenant_dbs:
    if db_name not in all_dbs:
        print(f"  Skipping {db_name} — does not exist")
        continue
    url = f"mysql+pymysql://{user}:{password}@{host}:{port}/{db_name}"
    engine = create_engine(url)
    try:
        TenantBase.metadata.create_all(bind=engine)
        print(f"  {db_name}: tables synced OK")
    except Exception as e:
        print(f"  {db_name}: ERROR — {e}")
    finally:
        engine.dispose()

print("Done.")
