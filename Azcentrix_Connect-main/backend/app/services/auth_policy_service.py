import logging

from sqlalchemy.orm import Session

from app.core.auth_defaults import (
    DEFAULT_NORMAL_LOGIN_EXPIRY_MINUTES,
    DEFAULT_REMEMBER_ME_EXPIRY_MINUTES,
)
from app.core.config import settings
from app.models.tenant import Tenant

logger = logging.getLogger(__name__)


def get_login_expiry_minutes(master_db: Session, tenant_slug: str, remember_me: bool = False) -> int:
    tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if not tenant:
        logger.warning('Tenant not found while resolving login expiry: %s', tenant_slug)
        return DEFAULT_REMEMBER_ME_EXPIRY_MINUTES if remember_me else DEFAULT_NORMAL_LOGIN_EXPIRY_MINUTES

    normal_expiry = max(1, int(tenant.normal_login_expiry_minutes or DEFAULT_NORMAL_LOGIN_EXPIRY_MINUTES))
    remember_expiry = max(normal_expiry, int(tenant.remember_me_expiry_minutes or DEFAULT_REMEMBER_ME_EXPIRY_MINUTES))

    return remember_expiry if remember_me else normal_expiry


def get_remember_me_expiry_minutes(tenant: Tenant | None) -> int:
    if tenant is None:
        return DEFAULT_REMEMBER_ME_EXPIRY_MINUTES
    normal_expiry = max(1, int(getattr(tenant, "normal_login_expiry_minutes", DEFAULT_NORMAL_LOGIN_EXPIRY_MINUTES) or DEFAULT_NORMAL_LOGIN_EXPIRY_MINUTES))
    return max(normal_expiry, int(getattr(tenant, "remember_me_expiry_minutes", DEFAULT_REMEMBER_ME_EXPIRY_MINUTES) or DEFAULT_REMEMBER_ME_EXPIRY_MINUTES))


def get_access_token_expiry_minutes(session_expiry_minutes: int) -> int:
    return max(1, min(int(session_expiry_minutes), int(settings.ACCESS_TOKEN_EXPIRE_MINUTES)))


def build_session_policy_payload(tenant: Tenant | None, remember_me: bool = False) -> dict[str, int]:
    if tenant is None:
        expiry = DEFAULT_REMEMBER_ME_EXPIRY_MINUTES if remember_me else DEFAULT_NORMAL_LOGIN_EXPIRY_MINUTES
    else:
        normal_expiry = max(1, int(tenant.normal_login_expiry_minutes or DEFAULT_NORMAL_LOGIN_EXPIRY_MINUTES))
        remember_expiry = max(normal_expiry, int(tenant.remember_me_expiry_minutes or DEFAULT_REMEMBER_ME_EXPIRY_MINUTES))
        expiry = remember_expiry if remember_me else normal_expiry
    return {"login_expiry_minutes": expiry}
