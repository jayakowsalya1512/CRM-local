"""Usage monitoring: tenant-wise usage against plan limits.

The path sits under ``/usage-monitoring`` and needs the Tenants view permission (as Usage & Limits); tenants outside
the caller's assigned scope are never read. Limit changes and notifications reuse the existing tenant endpoints.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.models.tenant import Tenant
from app.services import platform_controls as controls
from app.services import platform_usage as usage
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/usage-monitoring", dependencies=[Depends(enforce_platform_access)])


@router.get("")
def usage_monitoring(request: Request, period: str = Query("30d"), refresh: bool = Query(False), db: Session = Depends(get_master_db_dep)):
    if period not in usage.PERIOD_DAYS:
        raise HTTPException(status_code=400, detail="Period must be 24h, 7d, 30d or 90d")
    query = db.query(Tenant)
    allowed = scoped_tenant_ids(request)
    if allowed is not None:
        query = query.filter(Tenant.id.in_(allowed or [0]))
    data = usage.overview(db, query.order_by(Tenant.name).all(), period, refresh)
    db.commit()  # document storage re-measured for tenants whose cached counts expired
    ai_quota = controls.value(db, "aiQuota")
    return {
        "period": period,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        **data,
        "anomalies": usage.anomalies(data["tenants"], data["warn_percent"]),
        "rules": [
            ["Aggregation", "Hourly meters (API calls, AI queries, e-mails, storage); tenant counts read live, cached 5 min"],
            ["History", "Active users from sign-in sessions; e-mails before metering from notification delivery logs; API calls and AI queries only since metering began"],
            ["Overage policy", "Not billed – no overage pricing is configured"],
            ["Alert thresholds", f"{data['warn_percent']:g}% near limit · 100% over limit (no throttling)"],
            ["Fair-use cap (AI)", f"{float(ai_quota):,.0f} queries / tenant / month (not enforced)" if ai_quota else "Not set"],
            ["Idle-tenant flag", f"No sign-in for {usage.IDLE_DAYS} days"],
        ],
    }
