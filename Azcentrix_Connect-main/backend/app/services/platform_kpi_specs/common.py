"""Building blocks shared by the KPI spec modules."""

from __future__ import annotations

from app.services.platform_kpi import Col

TENANT_LINK = "/platform/tenants/{tenant_id}"

# Every tenant with its plan; filter it with an outer WHERE in the spec SQL.
TENANTS_SQL = """
SELECT t.id AS tenant_id, t.name AS tenant, t.slug, p.name AS plan, t.status, t.billing_status, t.admin_name, t.admin_email,
       t.max_users, t.used_storage AS storage_mb, t.storage_limit_mb, t.industry, t.created_at, t.trial_ends_at, t.subscription_end_date
FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id
"""

TENANT_COLS = [
    Col("tenant", "Tenant"), Col("slug", "Slug", "code"), Col("plan", "Plan"), Col("status", "Status", "pill"),
    Col("billing_status", "Billing", "pill"), Col("admin_email", "Admin e-mail"), Col("created_at", "Created", "date"),
    Col("tenant_id", "Tenant ID", "num", hidden=True), Col("admin_name", "Admin", hidden=True), Col("max_users", "User limit", "num", hidden=True),
    Col("storage_mb", "Storage used", "mb", hidden=True), Col("storage_limit_mb", "Storage limit", "mb", hidden=True),
    Col("industry", "Industry", hidden=True), Col("trial_ends_at", "Trial ends", "date", hidden=True),
    Col("subscription_end_date", "Subscription ends", "date", hidden=True),
]
TENANT_SEARCH = ("tenant", "slug", "admin_email", "plan")


def tenants_where(where: str) -> str:
    return f"SELECT * FROM ({TENANTS_SQL}) tt WHERE {where}"


def count_where(cond: str) -> str:
    """SQL aggregate counting the filtered rows that match ``cond`` (over the derived table ``q``)."""
    return f"COALESCE(SUM(CASE WHEN {cond} THEN 1 ELSE 0 END), 0)"
