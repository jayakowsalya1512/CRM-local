"""
Run migrate_tada.sql against all active tenant databases.
Usage:  python run_tada_migration.py
"""
import os
import sys

# Allow running from backend/ directory
sys.path.insert(0, os.path.dirname(__file__))

from app.core.config import settings
from app.database import MasterSessionLocal
from app.models.tenant import Tenant
import pymysql

SQL_FILE = os.path.join(os.path.dirname(__file__), "migrate_tada.sql")


def run_migration_on_tenant(slug: str):
    db_name = f"{settings.TENANT_DB_PREFIX}{slug}"
    conn = pymysql.connect(
        host=settings.TENANT_DB_HOST,
        port=settings.TENANT_DB_PORT,
        user=settings.TENANT_DB_USER,
        password=settings.TENANT_DB_PASSWORD,
        database=db_name,
        charset="utf8mb4",
    )
    try:
        with open(SQL_FILE, "r", encoding="utf-8") as f:
            sql = f.read()

        # Split on semicolons, skip comments and blank statements
        statements = [
            s.strip() for s in sql.split(";")
            if s.strip() and not s.strip().startswith("--")
        ]

        with conn.cursor() as cur:
            for stmt in statements:
                if not stmt:
                    continue
                try:
                    cur.execute(stmt)
                    print(f"  ✓ OK")
                except pymysql.err.OperationalError as e:
                    print(f"  ✗ ERROR: {e}")
        conn.commit()
        print(f"[{slug}] Migration committed.\n")
    finally:
        conn.close()


def main():
    master_db = MasterSessionLocal()
    try:
        tenants = master_db.query(Tenant).filter(Tenant.is_active == True).all()
        if not tenants:
            print("No active tenants found.")
            return
        print(f"Found {len(tenants)} active tenant(s).\n")
        for tenant in tenants:
            print(f"── Migrating tenant: {tenant.slug} ({tenant.name}) ──")
            try:
                run_migration_on_tenant(tenant.slug)
            except Exception as e:
                print(f"  FAILED for {tenant.slug}: {e}\n")
    finally:
        master_db.close()


if __name__ == "__main__":
    main()
