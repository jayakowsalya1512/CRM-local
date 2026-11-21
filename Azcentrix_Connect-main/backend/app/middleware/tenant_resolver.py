"""
Tenant Resolver Middleware â€” extracts tenant from subdomain or X-Tenant-Slug header.
Attaches tenant context to every request.
"""
import logging
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)

# Paths that don't require tenant context
PUBLIC_PATHS = {
    "/",
    "/health",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/api/v1/platform/login",
    "/api/v1/platform/tenants",
    "/api/v1/platform/plans",
    "/api/v1/platform/stats",
    "/api/v1/auth/forgot-password",
    "/api/v1/auth/reset-password",
    "/api/v1/auth/contact-administrator",
    "/api/v1/auth/maintenance-status",
}

# Subdomains that are NOT tenant identifiers
RESERVED_SUBDOMAINS = {"www", "api", "app", "mail", "admin", "staging", "dev", "test"}


class TenantResolverMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # DEBUG â€” print ALL headers received
        # print(f"\n>>> REQUEST: {request.method} {path}")
        # print(f">>> ALL HEADERS: {dict(request.headers)}")
        
        # Skip tenant resolution for public/platform paths
        if any(path.startswith(p) or path == p for p in PUBLIC_PATHS):
            request.state.tenant = None
            request.state.tenant_slug = None
            return await call_next(request)

        tenant_slug = None

        # 1. X-Tenant-Slug header (highest priority â€” dev/API clients)
        tenant_slug = request.headers.get("x-tenant-slug", "").strip() or None
        logger.info(f">>> X-Tenant-Slug from header: {tenant_slug}")

        # 2. Subdomain extraction  e.g.  ascent.crm.com â†’ ascent
        if not tenant_slug:
            host = (
                request.headers.get("X-Forwarded-Host") or
                request.headers.get("host", "")
            ).split(":")[0].strip()

            parts = host.split(".")
            if len(parts) >= 2:
                subdomain = parts[0].lower()
                if subdomain not in RESERVED_SUBDOMAINS and subdomain != "localhost":
                    tenant_slug = subdomain
            logger.info(f">>> Subdomain extracted: {tenant_slug} from host: {host}")

        # 3. Query param fallback  ?tenant=ascent  (useful for local testing)
        if not tenant_slug:
            tenant_slug = request.query_params.get("tenant", "").strip() or None
            logger.info(f">>> Query param tenant: {tenant_slug}")

        logger.info(f">>> FINAL tenant_slug: {tenant_slug}\n")

        if tenant_slug:
            logger.debug(f"Tenant resolved: '{tenant_slug}' for path {path}")
        else:
            logger.warning(f"No tenant resolved for path {path} | host={request.headers.get('host', '')}")

        request.state.tenant_slug = tenant_slug
        request.state.tenant = None  # Resolved lazily in get_tenant_db dependency

        return await call_next(request)
