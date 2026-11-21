"""
Standalone TA/DA migration runner — no app dependencies needed.
Reads DB credentials from .env or environment variables.
Usage:  python run_tada_migration_standalone.py
"""
import os
import sys

# ── Read credentials from .env if present ─────────────────────────────────────
env_path = os.path.join(os.path.dirname(__file__), ".env")
env = {}
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip().strip('"').strip("'")

def get_env(name, default=""):
    return os.environ.get(name) or env.get(name, default)


DB_HOST = get_env("TENANT_DB_HOST", "localhost")
DB_PORT = int(get_env("TENANT_DB_PORT", "3306"))
DB_USER = get_env("TENANT_DB_USER")
DB_PASS = get_env("TENANT_DB_PASSWORD")
DB_PREFIX = get_env("TENANT_DB_PREFIX", "digitcrm_")
MASTER_DB = get_env("MASTER_DATABASE_URL")

# Extract master DB credentials from URL if provided
if MASTER_DB:
    # mysql+pymysql://user:pass@host:port/dbname
    try:
        import re
        m = re.match(r"mysql\+pymysql://([^:]+):([^@]*)@([^:/]+):?(\d*)/(.+)", MASTER_DB)
        if m:
            M_USER, M_PASS, M_HOST, M_PORT, M_DB = m.groups()
            M_PORT = int(M_PORT) if M_PORT else 3306
        else:
            M_USER, M_PASS, M_HOST, M_PORT, M_DB = DB_USER, DB_PASS, DB_HOST, DB_PORT, "digitcrm_master"
    except Exception:
        M_USER, M_PASS, M_HOST, M_PORT, M_DB = DB_USER, DB_PASS, DB_HOST, DB_PORT, "digitcrm_master"
else:
    M_USER, M_PASS, M_HOST, M_PORT, M_DB = DB_USER, DB_PASS, DB_HOST, DB_PORT, "digitcrm_master"

try:
    import pymysql
except ImportError:
    print("ERROR: pymysql not installed. Run:  pip install pymysql")
    sys.exit(1)

SQL_FILE = os.path.join(os.path.dirname(__file__), "migrate_tada.sql")


def get_tenant_slugs():
    conn = pymysql.connect(host=M_HOST, port=M_PORT, user=M_USER, password=M_PASS,
                           database=M_DB, charset="utf8mb4")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT slug, name FROM tenants WHERE is_active = 1")
            return cur.fetchall()
    finally:
        conn.close()


def run_on_tenant(slug, name):
    db_name = f"{DB_PREFIX}{slug}"
    print(f"── Tenant: {slug} ({name})  →  {db_name}")
    conn = pymysql.connect(host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASS,
                           database=db_name, charset="utf8mb4")
    try:
        with open(SQL_FILE, "r", encoding="utf-8") as f:
            sql = f.read()

        # Split on semicolons; skip blank / comment-only chunks
        statements = []
        for chunk in sql.split(";"):
            lines = [l for l in chunk.splitlines() if l.strip() and not l.strip().startswith("--")]
            if lines:
                statements.append("\n".join(lines))

        with conn.cursor() as cur:
            for stmt in statements:
                try:
                    cur.execute(stmt)
                    print(f"  ✓  {stmt[:80].replace(chr(10),' ')}...")
                except pymysql.err.OperationalError as e:
                    code = e.args[0]
                    if code == 1060:   # Duplicate column — already applied
                        print(f"  –  Already exists (skipped)")
                    else:
                        print(f"  ✗  ERROR {code}: {e.args[1]}")
        conn.commit()
        print(f"  → Committed.\n")
    finally:
        conn.close()


def main():
    print(f"Master DB: {M_HOST}:{M_PORT}/{M_DB}\n")
    try:
        tenants = get_tenant_slugs()
    except Exception as e:
        print(f"Cannot connect to master DB: {e}")
        sys.exit(1)

    if not tenants:
        print("No active tenants found.")
        return

    print(f"Found {len(tenants)} active tenant(s).\n")
    for slug, name in tenants:
        try:
            run_on_tenant(slug, name)
        except Exception as e:
            print(f"  FAILED for {slug}: {e}\n")

    print("Done.")


if __name__ == "__main__":
    main()
