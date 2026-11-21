"""Team Chat schema bootstrap — same idempotent create-tables-once-per-process
pattern as app/services/inbox_service.py's ensure_inbox_schema."""
from __future__ import annotations

import logging
import threading

from sqlalchemy.orm import Session

from app.models.chat_models import CHAT_TABLES

logger = logging.getLogger(__name__)

_SCHEMA_READY: set[str] = set()
_SCHEMA_LOCK = threading.Lock()


def ensure_chat_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _SCHEMA_READY:
        return
    with _SCHEMA_LOCK:
        if slug in _SCHEMA_READY:
            return
        bind = db.get_bind()
        for table in CHAT_TABLES:
            table.create(bind=bind, checkfirst=True)
        # MariaDB refuses to read a table created after the current transaction's
        # snapshot began ("Table definition has changed") — same fix as inbox_service.
        db.commit()
        _SCHEMA_READY.add(slug)


def ensure_chat_schema_all_tenants() -> None:
    """Startup hook: create the Team Chat tables for every tenant."""
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant

    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant).all()]
    except Exception as exc:  # pragma: no cover - startup safety
        logger.warning("Team Chat schema sync: unable to list tenants: %s", exc)
        return
    finally:
        master.close()

    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_chat_schema(db)
            finally:
                db.close()
        except Exception as exc:
            logger.warning("Team Chat schema sync failed for %s: %s", slug, exc)
