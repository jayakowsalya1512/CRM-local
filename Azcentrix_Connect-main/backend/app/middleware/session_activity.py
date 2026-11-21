"""
Session activity middleware.

Enforces tenant inactivity windows on authenticated requests and keeps the
tenant-side UserSession.last_active timestamp fresh for interactive traffic.
"""
from __future__ import annotations

import logging

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.security import verify_token
from app.database import MasterSessionLocal, get_tenant_session_by_db_name, normalize_tenant_slug
from app.dependencies import ensure_session_within_activity_window, touch_user_session_activity
from app.middleware.tenant_resolver import RESERVED_SUBDOMAINS
from app.models.tenant import Tenant
from app.models.user import User, UserSession

logger = logging.getLogger(__name__)

SESSION_ACTIVITY_HEADER = "x-session-activity"
PASSIVE_SESSION_ACTIVITY_VALUE = "passive"


class SessionActivityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith("/api/v1/"):
            return await call_next(request)

        authorization = request.headers.get("authorization", "").strip()
        if not authorization.lower().startswith("bearer "):
            return await call_next(request)

        token = authorization[7:].strip()
        if not token:
            return await call_next(request)

        payload = verify_token(token, "access")
        if not payload:
            return await call_next(request)

        tenant_slug = (
            getattr(request.state, "tenant_slug", None)
            or request.headers.get("x-tenant-slug", "").strip()
            or request.query_params.get("tenant", "").strip()
            or None
        )
        if not tenant_slug:
            host = (
                request.headers.get("X-Forwarded-Host")
                or request.headers.get("host", "")
            ).split(":")[0].strip()
            parts = host.split(".")
            if len(parts) >= 2:
                subdomain = parts[0].lower()
                if subdomain not in RESERVED_SUBDOMAINS and subdomain != "localhost":
                    tenant_slug = subdomain
        if not tenant_slug:
            return await call_next(request)

        try:
            tenant_slug = normalize_tenant_slug(tenant_slug)
        except ValueError:
            return await call_next(request)

        try:
            token_tenant_id = int(payload.get("tenant_id"))
        except (TypeError, ValueError):
            return await call_next(request)

        try:
            user_id = int(payload.get("sub"))
        except (TypeError, ValueError):
            return await call_next(request)

        session_jti = str(payload.get("session_jti") or "").strip()
        passive_request = request.headers.get(SESSION_ACTIVITY_HEADER, "").strip().lower() == PASSIVE_SESSION_ACTIVITY_VALUE

        master_db = MasterSessionLocal()
        tenant_db = None
        try:
            tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
            if not tenant:
                return await call_next(request)
            if tenant.id != token_tenant_id:
                return await call_next(request)

            tenant_db = get_tenant_session_by_db_name(tenant.db_name, cache_key=tenant.slug)
            user = tenant_db.query(User).filter(User.id == user_id, User.is_active == True).first()
            if not user:
                return await call_next(request)

            session_row = None
            if session_jti:
                session_row = tenant_db.query(UserSession).filter(
                    UserSession.user_id == user.id,
                    UserSession.session_jti == session_jti,
                ).first()

            ensure_session_within_activity_window(tenant_db, tenant, session_row)
            if session_row is not None and not passive_request:
                touch_user_session_activity(tenant_db, session_row)
            tenant_db.commit()
        except Exception as exc:
            if tenant_db is not None:
                tenant_db.rollback()
            if getattr(exc, "status_code", None) == 401:
                return JSONResponse(
                    status_code=401,
                    content={"detail": str(getattr(exc, "detail", "Session expired. Please sign in again."))},
                    headers=getattr(exc, "headers", None) or {},
                )
            logger.debug("Session activity middleware skipped due to error: %s", exc)
        finally:
            master_db.close()
            if tenant_db is not None:
                tenant_db.close()

        return await call_next(request)
