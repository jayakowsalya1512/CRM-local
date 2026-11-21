"""
Master database (platform-level) — tenants, plans, super admin.
Each tenant has its own database resolved dynamically.
"""
import logging
import re
from urllib.parse import unquote
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import URL
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from app.core.auth_defaults import (
    DEFAULT_NORMAL_LOGIN_EXPIRY_MINUTES,
    DEFAULT_REMEMBER_ME_EXPIRY_MINUTES,
)
from app.core.config import settings

logger = logging.getLogger(__name__)

SAFE_TENANT_SLUG_RE = re.compile(r"^[a-z0-9_]+$")
SAFE_MYSQL_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9_]+$")


class Base(DeclarativeBase):
    pass


class TenantBase(DeclarativeBase):
    """Base class for all tenant-specific ORM models."""
    pass


# ─── Master DB ────────────────────────────────────────────────────────────────

master_engine = create_engine(
    settings.MASTER_DATABASE_URL,
    pool_size=20,
    max_overflow=30,
    pool_pre_ping=True,
    pool_recycle=300,
    pool_timeout=30,
    echo=settings.DEBUG,
    connect_args={"charset": "utf8mb4", "connect_timeout": 10},
)


@event.listens_for(master_engine, "connect")
def set_charset_master(dbapi_conn, _):
    cursor = dbapi_conn.cursor()
    cursor.execute("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci")
    cursor.execute("SET time_zone = '+05:30'")
    cursor.close()


MasterSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=master_engine)


def get_master_db():
    db = MasterSessionLocal()
    try:
        yield db
    finally:
        db.close()

get_master_db_dep = get_master_db


# ─── Tenant DB ────────────────────────────────────────────────────────────────

# FIX: Cache one engine per tenant instead of creating a new one every request.
# Before: every request → new engine → new pool of 5-15 connections → never reused
# After:  every request → same cached engine → connections reused from pool
_tenant_engines: dict = {}


def normalize_tenant_slug(tenant_slug: str) -> str:
    normalized = (tenant_slug or "").strip().lower()
    if not normalized:
        raise ValueError("Tenant slug is required.")
    if not SAFE_TENANT_SLUG_RE.fullmatch(normalized):
        raise ValueError("Tenant slug may contain only lowercase letters, numbers, and underscores.")
    return normalized


def validate_mysql_identifier(identifier: str, *, field_name: str = "identifier") -> str:
    normalized = (identifier or "").strip()
    if not normalized:
        raise ValueError(f"{field_name.capitalize()} is required.")
    if not SAFE_MYSQL_IDENTIFIER_RE.fullmatch(normalized):
        raise ValueError(f"Invalid {field_name}.")
    return normalized


def build_tenant_db_name(tenant_slug: str) -> str:
    db_name = f"{settings.TENANT_DB_PREFIX}{normalize_tenant_slug(tenant_slug)}"
    return validate_mysql_identifier(db_name, field_name="database name")


def quote_mysql_identifier(identifier: str) -> str:
    safe_identifier = validate_mysql_identifier(identifier, field_name="database name")
    return f"`{safe_identifier}`"


def tenant_db_url(db_name: str) -> URL:
    """Tenant DB URL built from its parts, so a password with @ : / # etc. can't be misread as the host."""
    # unquote: a password kept percent-encoded in .env (as provisioning already accepts) still works.
    return URL.create("mysql+pymysql", username=settings.TENANT_DB_USER, password=unquote(settings.TENANT_DB_PASSWORD or ""),
                      host=settings.TENANT_DB_HOST, port=settings.TENANT_DB_PORT, database=db_name)


def _build_tenant_engine(db_name: str):
    validated_db_name = validate_mysql_identifier(db_name, field_name="database name")
    url = tenant_db_url(validated_db_name)
    engine = create_engine(
        url,
        pool_size=5,
        max_overflow=10,
        pool_pre_ping=True,
        pool_recycle=300,
        pool_timeout=10,
        echo=settings.DEBUG,
        connect_args={"charset": "utf8mb4", "connect_timeout": 10},
    )

    @event.listens_for(engine, "connect")
    def set_charset(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci")
        cursor.execute("SET time_zone = '+05:30'")
        cursor.close()

    return engine


def get_tenant_engine_by_db_name(db_name: str, *, cache_key: str | None = None):
    validated_db_name = validate_mysql_identifier(db_name, field_name="database name")
    engine_cache_key = (cache_key or validated_db_name).strip().lower()
    if engine_cache_key in _tenant_engines:
        return _tenant_engines[engine_cache_key]

    engine = _build_tenant_engine(validated_db_name)
    _tenant_engines[engine_cache_key] = engine
    logger.info("Created and cached DB engine for tenant DB: %s", validated_db_name)
    return engine


def get_tenant_engine(tenant_slug: str):
    """Return a cached engine for the tenant. Creates it only on first call."""
    tenant_slug = normalize_tenant_slug(tenant_slug)
    db_name = build_tenant_db_name(tenant_slug)
    return get_tenant_engine_by_db_name(db_name, cache_key=tenant_slug)


# Cache sessionmakers too — no need to recreate them each time
_tenant_session_factories: dict = {}


def get_tenant_session_by_db_name(db_name: str, *, cache_key: str | None = None):
    session_cache_key = (cache_key or db_name).strip().lower()
    if session_cache_key not in _tenant_session_factories:
        engine = get_tenant_engine_by_db_name(db_name, cache_key=session_cache_key)
        _tenant_session_factories[session_cache_key] = sessionmaker(
            autocommit=False, autoflush=False, bind=engine
        )
    return _tenant_session_factories[session_cache_key]()


def get_tenant_session(tenant_slug: str):
    """Return a new Session using the cached engine for this tenant."""
    tenant_slug = normalize_tenant_slug(tenant_slug)
    db_name = build_tenant_db_name(tenant_slug)
    return get_tenant_session_by_db_name(db_name, cache_key=tenant_slug)


# ─── Table creation ───────────────────────────────────────────────────────────

def _ensure_tenant_auth_columns():
    inspector = inspect(master_engine)
    if "tenants" not in inspector.get_table_names():
        return

    column_names = {column["name"] for column in inspector.get_columns("tenants")}
    statements = []

    if "maintenance_mode" not in column_names:
        statements.append("ALTER TABLE tenants ADD COLUMN maintenance_mode BOOLEAN NOT NULL DEFAULT 0")

    if "normal_login_expiry_minutes" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            f"ADD COLUMN normal_login_expiry_minutes INTEGER NOT NULL DEFAULT {DEFAULT_NORMAL_LOGIN_EXPIRY_MINUTES}"
        )
    if "remember_me_expiry_minutes" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            f"ADD COLUMN remember_me_expiry_minutes INTEGER NOT NULL DEFAULT {DEFAULT_REMEMBER_ME_EXPIRY_MINUTES}"
        )
    if "smtp_host" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN smtp_host VARCHAR(255) NULL"
        )
    if "smtp_port" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN smtp_port INTEGER NULL"
        )
    if "smtp_user" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN smtp_user VARCHAR(255) NULL"
        )
    if "smtp_password" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN smtp_password VARCHAR(255) NULL"
        )
    if "smtp_use_tls" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN smtp_use_tls BOOLEAN NOT NULL DEFAULT 1"
        )
    if "smtp_use_ssl" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN smtp_use_ssl BOOLEAN NOT NULL DEFAULT 0"
        )
    if "from_email" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN from_email VARCHAR(255) NULL"
        )
    if "company_mail" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN company_mail VARCHAR(255) NULL"
        )
    if "address" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN address TEXT NULL"
        )
    if "street_address" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN street_address TEXT NULL"
        )
    if "pincode" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN pincode VARCHAR(20) NULL"
        )
    if "country" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN country VARCHAR(100) NOT NULL DEFAULT 'India'"
        )
    if "state" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN state VARCHAR(255) NULL"
        )
    if "city_district" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN city_district VARCHAR(255) NULL"
        )
    if "area_locality" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN area_locality VARCHAR(255) NULL"
        )
    if "forgot_password_enabled" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN forgot_password_enabled BOOLEAN NOT NULL DEFAULT 1"
        )
    if "self_service_reset_limit_count" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN self_service_reset_limit_count INTEGER NOT NULL DEFAULT 1"
        )
    if "self_service_reset_limit_days" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN self_service_reset_limit_days INTEGER NOT NULL DEFAULT 30"
        )
    if "forgot_password_send_max_attempts" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN forgot_password_send_max_attempts INTEGER NOT NULL DEFAULT 5"
        )
    if "forgot_password_send_window_minutes" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN forgot_password_send_window_minutes INTEGER NOT NULL DEFAULT 15"
        )
    if "forgot_password_ip_max_attempts" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN forgot_password_ip_max_attempts INTEGER NOT NULL DEFAULT 10"
        )
    if "forgot_password_ip_window_minutes" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN forgot_password_ip_window_minutes INTEGER NOT NULL DEFAULT 15"
        )
    if "password_expiry_enabled" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN password_expiry_enabled BOOLEAN NOT NULL DEFAULT 0"
        )
    if "password_expiry_days" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN password_expiry_days INTEGER NOT NULL DEFAULT 30"
        )
    if "used_storage" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN used_storage DOUBLE NOT NULL DEFAULT 0"
        )
    if "otp_mode" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN otp_mode VARCHAR(20) NOT NULL DEFAULT 'always'"
        )
    if "captcha_mode" not in column_names:
        statements.append(
            "ALTER TABLE tenants "
            "ADD COLUMN captcha_mode VARCHAR(20) NOT NULL DEFAULT 'after_failed'"
        )

    if not statements:
        return

    with master_engine.begin() as conn:
        for statement in statements:
            conn.execute(text(statement))

    logger.info("✅ Tenant auth expiry columns created/verified")


def create_master_tables():
    from app.models.tenant import Tenant, Plan, Feature, PlanFeature, SuperAdmin, ForgotPasswordSendAttempt, PlatformSetting, PlatformSession, PlatformSessionPolicy  # noqa
    Base.metadata.create_all(bind=master_engine)
    _ensure_tenant_auth_columns()
    logger.info("✅ Master DB tables created/verified")


def sync_tenant_user_auth_columns():
    from app.models.tenant import Tenant
    from app.models.all_models import TenantBase  # noqa

    statements = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_password_changed_at DATETIME NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_window_start DATETIME NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_self_service_reset_at DATETIME NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS reporting_manager_ids JSON NULL",
        "ALTER TABLE alerts ADD COLUMN IF NOT EXISTS email_sent_at DATETIME NULL",
    ]

    db = MasterSessionLocal()
    try:
        tenants = db.query(Tenant).all()
    except Exception as exc:
        logger.warning("Unable to load tenants for auth column sync: %s", exc)
        return
    finally:
        db.close()

    for tenant in tenants:
        try:
            engine = get_tenant_engine(tenant.slug)
            TenantBase.metadata.create_all(bind=engine)
            with engine.begin() as conn:
                for statement in statements:
                    conn.execute(text(statement))
            logger.info("✅ Tenant user auth columns created/verified: %s", tenant.slug)
        except Exception as exc:
            logger.warning("Tenant user auth column sync failed for %s: %s", tenant.slug, exc)


def sync_tenant_competitor_columns():
    from app.models.tenant import Tenant
    from app.models.all_models import TenantBase  # noqa

    statements = [
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS registration_type VARCHAR(100) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS registration_year VARCHAR(10) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS country VARCHAR(100) NULL DEFAULT 'India'",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS state VARCHAR(100) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS district VARCHAR(100) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS city VARCHAR(100) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS address TEXT NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS pincode VARCHAR(20) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS mobile_no VARCHAR(30) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS gst_no VARCHAR(30) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS pan_no VARCHAR(30) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS email VARCHAR(200) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS company_type VARCHAR(200) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS directors TEXT NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS manpower_strength VARCHAR(100) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS threat_level VARCHAR(50) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS market_reputation TEXT NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS oem_partnerships TEXT NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS strong_regions TEXT NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS strong_departments TEXT NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS annual_turnover VARCHAR(100) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS support_quality VARCHAR(100) NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS internal_notes TEXT NULL",
        "ALTER TABLE competitors DROP COLUMN IF EXISTS competitor_no",
    ]

    db = MasterSessionLocal()
    try:
        tenants = db.query(Tenant).all()
    except Exception as exc:
        logger.warning("Unable to load tenants for competitor column sync: %s", exc)
        return
    finally:
        db.close()

    for tenant in tenants:
        try:
            engine = get_tenant_engine(tenant.slug)
            TenantBase.metadata.create_all(bind=engine)
            with engine.begin() as conn:
                for statement in statements:
                    conn.execute(text(statement))
            logger.info("✅ Tenant competitor columns created/verified: %s", tenant.slug)
        except Exception as exc:
            logger.warning("Tenant competitor column sync failed for %s: %s", tenant.slug, exc)


def sync_tenant_document_folder_columns():
    from app.models.tenant import Tenant
    from app.models.all_models import TenantBase  # noqa

    statements = [
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS folder_id INTEGER NULL",
    ]

    db = MasterSessionLocal()
    try:
        tenants = db.query(Tenant).all()
    except Exception as exc:
        logger.warning("Unable to load tenants for document folder column sync: %s", exc)
        return
    finally:
        db.close()

    for tenant in tenants:
        try:
            engine = get_tenant_engine(tenant.slug)
            TenantBase.metadata.create_all(bind=engine)
            with engine.begin() as conn:
                for statement in statements:
                    conn.execute(text(statement))
            logger.info("✅ Tenant document folder columns created/verified: %s", tenant.slug)
        except Exception as exc:
            logger.warning("Tenant document folder column sync failed for %s: %s", tenant.slug, exc)


def sync_tenant_letter_management_tables():
    """Create and initialize the Letter Management tables for every tenant."""
    from app.models.tenant import Tenant
    from app.models.all_models import (
        Letter,
        LetterDocument,
        LetterHistory,
        LetterTemplate,
        LetterType,
    )

    letter_tables = [
        LetterType.__table__,
        LetterTemplate.__table__,
        Letter.__table__,
        LetterDocument.__table__,
        LetterHistory.__table__,
    ]

    # These are the shared starter templates shown when a tenant first opens
    # Letter Management.  They are real tenant records (not front-end demo
    # data), so any later delete correctly enters the Recycle Bin.
    starter_templates = [
        ("Quotation", "Standard Quotation", "Quotation for {{project_name}} – Ref: {{ref_no}}", "Dear {{recipient_name}},\n\nPlease find our quotation for {{project_name}} attached.\n\nRegards,\n{{company_name}}", True, True),
        ("Quotation", "Government Tender Quote", "Tender quotation – {{tender_name}}", "Dear {{recipient_name}},\n\nWe are pleased to submit our quotation for tender {{tender_name}} ({{tender_no}}).\n\nRegards,\n{{company_name}}", False, True),
        ("Letter", "Covering Letter", "Covering letter – {{project_name}}", "Dear {{recipient_name}},\n\nPlease find the enclosed documents for {{project_name}}.\n\nRegards,\n{{company_name}}", False, True),
    ]

    db = MasterSessionLocal()
    try:
        tenants = db.query(Tenant).all()
    except Exception as exc:
        logger.warning("Unable to load tenants for letter management table sync: %s", exc)
        return
    finally:
        db.close()

    for tenant in tenants:
        try:
            engine = get_tenant_engine(tenant.slug)
            for table in letter_tables:
                table.create(bind=engine, checkfirst=True)
            session = sessionmaker(autocommit=False, autoflush=False, bind=engine)()
            try:
                # Count all rows, including soft-deleted ones.  A tenant that
                # intentionally deletes every starter template must not have
                # them re-created on the next application startup.
                if session.query(LetterTemplate.id).first() is None:
                    types: dict[str, object] = {}
                    for category, name, subject, body, is_default, is_active in starter_templates:
                        letter_type = types.get(category)
                        if letter_type is None:
                            letter_type = LetterType(key=category.lower(), name=category)
                            session.add(letter_type)
                            session.flush()
                            types[category] = letter_type
                        session.add(LetterTemplate(
                            letter_type_id=letter_type.id,
                            name=name,
                            subject=subject,
                            template_body=body,
                            variables=["recipient_name", "project_name", "tender_name", "tender_no", "ref_no", "company_name"],
                            version=1,
                            is_default=is_default,
                            is_active=is_active,
                        ))
                    session.commit()
            finally:
                session.close()
            logger.info("Tenant letter management tables created/verified: %s", tenant.slug)
        except Exception as exc:
            logger.warning("Tenant letter management table sync failed for %s: %s", tenant.slug, exc)


def sync_tenant_letter_management_columns():
    """Add newer Letter Management columns to existing tenant databases."""
    from app.models.tenant import Tenant
    from app.models.all_models import TenantBase  # noqa

    statements = [
        "ALTER TABLE letter_templates ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE letter_templates ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL",
        "ALTER TABLE letter_templates ADD COLUMN IF NOT EXISTS deleted_by INT NULL",
        "ALTER TABLE letter_templates ADD COLUMN IF NOT EXISTS folder VARCHAR(200) NULL",
        "ALTER TABLE letter_templates ADD COLUMN IF NOT EXISTS description TEXT NULL",
        "ALTER TABLE letters ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE letters ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL",
        "ALTER TABLE letters ADD COLUMN IF NOT EXISTS deleted_by INT NULL",
    ]

    db = MasterSessionLocal()
    try:
        tenants = db.query(Tenant).all()
    except Exception as exc:
        logger.warning("Unable to load tenants for letter management column sync: %s", exc)
        return
    finally:
        db.close()

    for tenant in tenants:
        try:
            engine = get_tenant_engine(tenant.slug)
            TenantBase.metadata.create_all(bind=engine)
            with engine.begin() as conn:
                for statement in statements:
                    conn.execute(text(statement))
            logger.info("✅ Tenant letter management columns created/verified: %s", tenant.slug)
        except Exception as exc:
            logger.warning("Tenant letter management column sync failed for %s: %s", tenant.slug, exc)


def sync_tenant_quotation_approval_columns():
    from app.models.tenant import Tenant
    from app.models.all_models import TenantBase  # noqa

    statements = [
        "ALTER TABLE quotations ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NULL DEFAULT 'none'",
        "ALTER TABLE quotations ADD COLUMN IF NOT EXISTS approval_id INT NULL",
        # Letter-pad fields
        "ALTER TABLE quotations ADD COLUMN IF NOT EXISTS ref_number VARCHAR(100) NULL",
        "ALTER TABLE quotations ADD COLUMN IF NOT EXISTS customer_to_name VARCHAR(300) NULL",
        "ALTER TABLE quotations ADD COLUMN IF NOT EXISTS customer_address_text TEXT NULL",
        "ALTER TABLE quotations ADD COLUMN IF NOT EXISTS greeting_text TEXT NULL",
        "ALTER TABLE quotations ADD COLUMN IF NOT EXISTS signatory_user_id INT NULL",
        # Line item breakdown columns
        "ALTER TABLE quotation_line_items ADD COLUMN IF NOT EXISTS net_price DECIMAL(15,2) NOT NULL DEFAULT 0",
        "ALTER TABLE quotation_line_items ADD COLUMN IF NOT EXISTS gst_value DECIMAL(15,2) NOT NULL DEFAULT 0",
        # Company header overrides
        "ALTER TABLE quotations ADD COLUMN IF NOT EXISTS company_name_override VARCHAR(300) NULL",
        "ALTER TABLE quotations ADD COLUMN IF NOT EXISTS company_address_override TEXT NULL",
    ]

    db = MasterSessionLocal()
    try:
        tenants = db.query(Tenant).all()
    except Exception as exc:
        logger.warning("Unable to load tenants for quotation approval column sync: %s", exc)
        return
    finally:
        db.close()

    for tenant in tenants:
        try:
            engine = get_tenant_engine(tenant.slug)
            TenantBase.metadata.create_all(bind=engine)
            with engine.begin() as conn:
                for statement in statements:
                    conn.execute(text(statement))
            logger.info("✅ Tenant quotation approval columns created/verified: %s", tenant.slug)
        except Exception as exc:
            logger.warning("Tenant quotation approval column sync failed for %s: %s", tenant.slug, exc)


def sync_tenant_approval_escalation_schema():
    from app.models.tenant import Tenant
    from app.models.all_models import TenantBase  # noqa
    from app.services.generic_approval_engine import ensure_generic_approval_schema

    db = MasterSessionLocal()
    try:
        tenants = db.query(Tenant).all()
    except Exception as exc:
        logger.warning("Unable to load tenants for approval schema sync: %s", exc)
        return
    finally:
        db.close()

    for tenant in tenants:
        session = None
        try:
            engine = get_tenant_engine(tenant.slug)
            TenantBase.metadata.create_all(bind=engine)
            session = get_tenant_session(tenant.slug)
            ensure_generic_approval_schema(session)
            session.commit()
            logger.info("✅ Tenant approval escalation schema synced: %s", tenant.slug)
        except Exception as exc:
            if session is not None:
                session.rollback()
            logger.warning("Tenant approval escalation schema sync failed for %s: %s", tenant.slug, exc)
        finally:
            if session is not None:
                session.close()


def sync_tenant_misc_columns():
    """Add columns that were added to models after initial tenant provisioning."""
    from app.models.tenant import Tenant
    from app.models.all_models import TenantBase  # noqa

    statements = [
        # Customers table — group_name added after initial schema
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS group_name VARCHAR(100) NULL",
        # Role-permissions — data_scope for granular scoping
        "ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS data_scope VARCHAR(20) NULL",
        # Users — JSON preference columns
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS sidebar_order JSON NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_layout JSON NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_overrides JSON NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS region_id VARCHAR(255) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS state_id VARCHAR(255) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS group_id VARCHAR(255) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS target DECIMAL(15,2) NULL",
        # KAM targets — sales_target added after initial schema
        "ALTER TABLE kam_targets MODIFY COLUMN id INT NOT NULL AUTO_INCREMENT",
        "ALTER TABLE kam_targets ADD COLUMN IF NOT EXISTS sales_target DECIMAL(15,0) NULL",
        "ALTER TABLE kam_targets MODIFY COLUMN sales_target DECIMAL(15,0) NULL",
        "ALTER TABLE kam_group_targets MODIFY COLUMN id INT NOT NULL AUTO_INCREMENT",
        # Org tree — group_name and group_lead_id
        "ALTER TABLE org_tree_nodes ADD COLUMN IF NOT EXISTS group_name VARCHAR(150) NULL",
        "ALTER TABLE org_tree_nodes ADD COLUMN IF NOT EXISTS group_lead_id INT NULL",
        # Modules — custom display name for sidebar renaming
        "ALTER TABLE modules ADD COLUMN IF NOT EXISTS display_name VARCHAR(100) NULL",
        "ALTER TABLE modules ADD COLUMN IF NOT EXISTS display_name_singular VARCHAR(100) NULL",
        # Dynamic forms — custom field values stored as JSON blob
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS custom_data JSON NULL",
        "ALTER TABLE leads ADD COLUMN IF NOT EXISTS custom_data JSON NULL",
        "ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversion_target VARCHAR(30) NULL COMMENT 'Chosen conversion path: tender or quotation'",
        "ALTER TABLE tenders ADD COLUMN IF NOT EXISTS custom_data JSON NULL",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS custom_data JSON NULL",
        "ALTER TABLE competitors ADD COLUMN IF NOT EXISTS custom_data JSON NULL",
        "ALTER TABLE oems ADD COLUMN IF NOT EXISTS custom_data JSON NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_data JSON NULL",
        "ALTER TABLE travel_requests ADD COLUMN IF NOT EXISTS custom_data JSON NULL",
        "ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0",
        # Document Management trash
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL",
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS deleted_by INT NULL",
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS linked_source VARCHAR(40) NULL",
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS linked_record_id INT NULL",
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS linked_record_label VARCHAR(300) NULL",
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS doc_type VARCHAR(120) NULL",
        # Document Management approval workflow
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS approval_status VARCHAR(30) NULL",
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS submitted_by INT NULL",
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS submitted_at DATETIME NULL",
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS approval_decided_by INT NULL",
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS approval_decided_at DATETIME NULL",
        "ALTER TABLE document_management_files ADD COLUMN IF NOT EXISTS approval_comment VARCHAR(1000) NULL",
        "INSERT IGNORE INTO permissions (`key`, module, action, description) VALUES ('document_management.approve', 'document_management', 'approve', 'Approve or reject documents submitted for approval')",
        (
            "CREATE TABLE IF NOT EXISTS document_trash ("
            "id INT NOT NULL AUTO_INCREMENT, "
            "document_id VARCHAR(160) NOT NULL, "
            "trashed_by INT NULL, "
            "trashed_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP, "
            "deleted_by INT NULL, "
            "deleted_at DATETIME NULL, "
            "PRIMARY KEY (id), "
            "UNIQUE KEY uq_document_trash_document (document_id), "
            "KEY ix_document_trash_document_id (document_id)"
            ")"
        ),
        # Form Builder permission — insert if not already present
        "INSERT IGNORE INTO permissions (`key`, module, action, description) VALUES ('form_builder.manage', 'form_builder', 'manage', 'Manage Form Builder — customize field labels and add custom fields')",
        # Audit logs — human-readable record name (customer/lead/etc. name) alongside record_id
        "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS record_name VARCHAR(255) NULL",
    ]

    db = MasterSessionLocal()
    try:
        tenants = db.query(Tenant).all()
    except Exception as exc:
        logger.warning("Unable to load tenants for misc column sync: %s", exc)
        return
    finally:
        db.close()

    for tenant in tenants:
        try:
            engine = get_tenant_engine(tenant.slug)
            TenantBase.metadata.create_all(bind=engine)
            with engine.begin() as conn:
                for stmt in statements:
                    try:
                        conn.execute(text(stmt))
                    except Exception as col_exc:
                        logger.debug("Column migration skipped for %s: %s", tenant.slug, col_exc)
            logger.info("✅ Tenant misc columns synced: %s", tenant.slug)
        except Exception as exc:
            logger.warning("Tenant misc column sync failed for %s: %s", tenant.slug, exc)


def sync_tenant_missing_permissions():
    """Insert any permissions from DEFAULT_TENANT_PERMISSIONS that are missing from tenant DBs."""
    from app.models.tenant import Tenant
    from app.models.all_models import Permission
    from app.services.tenant_module_service import DEFAULT_TENANT_PERMISSIONS

    master_db = MasterSessionLocal()
    try:
        tenants = master_db.query(Tenant).filter(Tenant.status.in_(["active", "trial"])).all()
    except Exception as exc:
        logger.warning("sync_tenant_missing_permissions: cannot load tenants: %s", exc)
        return
    finally:
        master_db.close()

    for tenant in tenants:
        try:
            engine = get_tenant_engine(tenant.slug)
            with engine.begin() as conn:
                existing = {row[0] for row in conn.execute(text("SELECT `key` FROM permissions")).fetchall()}
                for key, module_name, action, description in DEFAULT_TENANT_PERMISSIONS:
                    if key not in existing:
                        conn.execute(
                            text("INSERT IGNORE INTO permissions (`key`, module, action, description) VALUES (:k, :m, :a, :d)"),
                            {"k": key, "m": module_name, "a": action, "d": description},
                        )
            engine.dispose()
        except Exception as exc:
            logger.warning("sync_tenant_missing_permissions skipped %s: %s", tenant.slug, exc)


def sync_tenant_runtime_catalogs():
    from app.models.tenant import Feature, PlanFeature, Tenant, TenantFeature
    from app.models.all_models import TenantBase  # noqa
    from app.services.tenant_module_service import sync_tenant_runtime_catalog

    db = MasterSessionLocal()
    try:
        tenants = db.query(Tenant).all()
        plan_ids = sorted({tenant.plan_id for tenant in tenants if tenant.plan_id})
        enabled_feature_keys_by_plan: dict[int, list[str]] = {}

        for plan_id in plan_ids:
            rows = (
                db.query(Feature.key)
                .join(PlanFeature, PlanFeature.feature_id == Feature.id)
                .filter(
                    PlanFeature.plan_id == plan_id,
                    PlanFeature.enabled == True,
                )
                .all()
            )
            enabled_feature_keys_by_plan[plan_id] = [row[0] for row in rows if row and row[0]]

        # Load tenant-specific feature overrides (saved via platform UI)
        tenant_feature_rows = (
            db.query(TenantFeature.tenant_id, Feature.key)
            .join(Feature, Feature.id == TenantFeature.feature_id)
            .filter(TenantFeature.enabled == True)
            .all()
        )
        enabled_feature_keys_by_tenant: dict[int, list[str]] = {}
        for tenant_id, feature_key in tenant_feature_rows:
            enabled_feature_keys_by_tenant.setdefault(tenant_id, []).append(feature_key)

    except Exception as exc:
        logger.warning("Unable to load tenants for runtime catalog sync: %s", exc)
        return
    finally:
        db.close()

    for tenant in tenants:
        session = None
        try:
            engine = get_tenant_engine(tenant.slug)
            TenantBase.metadata.create_all(bind=engine)
            session = get_tenant_session(tenant.slug)

            # Prefer tenant-specific overrides; fall back to plan-level features
            if tenant.id in enabled_feature_keys_by_tenant:
                effective_keys = enabled_feature_keys_by_tenant[tenant.id]
            elif tenant.plan_id:
                effective_keys = enabled_feature_keys_by_plan.get(tenant.plan_id)
            else:
                effective_keys = None

            sync_tenant_runtime_catalog(
                session,
                enabled_feature_keys=effective_keys,
                assign_permissions_to_admin_role=True,
            )
            from app.routers.report_engine_router import seed_system_reports as _seed_reports
            n_reports = _seed_reports(session)
            session.commit()
            logger.info(
                "✅ Tenant runtime modules/permissions synced: %s (%d system reports seeded)",
                tenant.slug, n_reports,
            )
        except Exception as exc:
            if session is not None:
                session.rollback()
            logger.warning("Tenant runtime catalog sync failed for %s: %s", tenant.slug, exc)
        finally:
            if session is not None:
                session.close()
