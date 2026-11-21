"""KPI drill-down specs, one module per platform area. Importing this package registers every KPI (platform_kpi.REGISTRY)."""

from app.services.platform_kpi_specs import core  # noqa: F401
from app.services.platform_kpi_specs import business  # noqa: F401
from app.services.platform_kpi_specs import governance  # noqa: F401
from app.services.platform_kpi_specs import infra  # noqa: F401
from app.services.platform_kpi_specs import tenants  # noqa: F401
