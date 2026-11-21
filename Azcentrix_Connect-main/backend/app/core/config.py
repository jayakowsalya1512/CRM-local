"""
Application configuration — reads from .env or environment variables.
SaaS Multi-Tenant CRM — E Digit Solutions Pvt Ltd
"""
from functools import lru_cache
from pathlib import Path
from typing import List
from pydantic_settings import BaseSettings


BASE_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    # App identity
    APP_NAME: str = "DigitCRM SaaS"
    APP_VERSION: str = "3.0.0"
    DEBUG: bool = False

    # JWT Security
    SECRET_KEY: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    DEFAULT_NORMAL_LOGIN_EXPIRY_MINUTES: int = 60
    DEFAULT_REMEMBER_ME_EXPIRY_MINUTES: int = 1440
    DEFAULT_INACTIVITY_TIMEOUT_MINUTES: int = 15
    DEFAULT_SESSION_WARNING_MINUTES: int = 2

    # Master/Platform Database (for tenants, plans, super admin)
    MASTER_DATABASE_URL: str = ""

    # Tenant DB prefix — each tenant gets database: digitcrm_<slug>
    TENANT_DB_PREFIX: str = "digitcrm_"
    TENANT_DB_HOST: str = "localhost"
    TENANT_DB_PORT: int = 3306
    TENANT_DB_USER: str = ""
    TENANT_DB_PASSWORD: str = ""

    # Platform infrastructure inventory (JSON list; empty = auto-detect this server + TENANT_DB_HOST)
    PLATFORM_SERVERS: str = ""
    # Shared secret for /platform/infrastructure/node-metrics on remote servers
    PLATFORM_AGENT_TOKEN: str = ""
    # Databases page: allow promoting a replica. Enable only when TENANT_DB_HOST is a virtual IP / proxy that follows the promoted server.
    PLATFORM_DB_FAILOVER_ENABLED: bool = False
    # Command Center service targets (objectives the live metrics are measured against)
    PLATFORM_SLO_P95_MS: int = 300
    PLATFORM_ERROR_BUDGET_PERCENT: float = 1.0
    PLATFORM_SLA_PERCENT: float = 99.9
    # Infrastructure & releases: command line of the deployment service on this server (empty = releases can't be run).
    # Contract in app/services/platform_releases.py; deploy/azcentrix-deploy.sh is a reference implementation.
    PLATFORM_DEPLOY_COMMAND: str = ""
    PLATFORM_DEPLOY_TIMEOUT_SECONDS: int = 1800
    # Result files and step logs of deployment runs (relative paths are below the backend folder)
    PLATFORM_DEPLOY_STATE_DIR: str = "deploy_state"

    # CORS
    ALLOWED_ORIGINS: List[str] = ["http://localhost:3000", "http://localhost:5173"]
    FRONTEND_BASE_URL: str = "https://ascent.crm.azcentrix.com:4447"

    # Security
    MAX_LOGIN_ATTEMPTS: int = 5
    LOCKOUT_DURATION_MINUTES: int = 30
    CAPTCHA_AFTER_ATTEMPTS: int = 3
    PASSWORD_MIN_LENGTH: int = 8
    PASSWORD_RESET_TOKEN_EXPIRE_MINUTES: int = 5

    # Email (SMTP)
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    EMAILS_FROM: str = "noreply@digitcrm.com"

    # Platform invoice payments (Invoices & dunning → Gateways). Server-side only; never sent to the browser.
    RAZORPAY_KEY_ID: str = ""
    RAZORPAY_KEY_SECRET: str = ""
    RAZORPAY_WEBHOOK_SECRET: str = ""
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    BANK_ACCOUNT_NAME: str = ""
    BANK_ACCOUNT_NUMBER: str = ""
    BANK_IFSC: str = ""

    # File storage
    UPLOAD_DIR: str = "uploads"
    MEDIA_ROOT: str = "media"
    MAX_UPLOAD_SIZE_MB: int = 10
    # Documents & Storage: cold tier = a slower/cheaper disk or NAS mount (empty = no cold tier);
    # quarantined files are moved here, outside every served folder.
    STORAGE_COLD_DIR: str = ""
    STORAGE_QUARANTINE_DIR: str = "storage_quarantine"
    # Malware scanner: "auto" tries clamd (CLAMAV_HOST), clamdscan/clamscan, then Windows Defender; "none" disables scanning.
    MALWARE_SCANNER: str = "auto"
    CLAMAV_HOST: str = ""
    CLAMAV_PORT: int = 3310

    # Firebase Cloud Messaging
    FIREBASE_SERVICE_ACCOUNT_PATH: str = str(BASE_DIR / "service-account.json")

    # RFP AI Analysis
    RFP_OLLAMA_URL: str = "http://localhost:11434/api/generate"
    RFP_LLM_MODEL: str = "mistral"
    RFP_MAX_AI_CHARS: int = 24000
    RFP_MAX_FILE_MB: int = 80

    # AI Smart Search (natural-language "ask" mode over CRM data)
    OPENAI_API_KEY: str = ""
    AI_SEARCH_MODEL: str = "gpt-4o-mini"
    AI_SEARCH_ENABLED: bool = False

    # Calendar & Tasks → Sync calendar (Google OAuth 2.0 web client; redirect defaults to
    # FRONTEND_BASE_URL + /api/v1/calendar/sync/google/callback and must be registered in Google Cloud)
    GOOGLE_CALENDAR_CLIENT_ID: str = ""
    GOOGLE_CALENDAR_CLIENT_SECRET: str = ""
    GOOGLE_CALENDAR_REDIRECT_URI: str = ""

    # Redis (for rate limiting / session / caching)
    REDIS_URL: str = "redis://localhost:6379/0"

    # Celery (background task queue — offloads slow email/push sends off the request thread)
    CELERY_BROKER_URL: str = REDIS_URL
    CELERY_RESULT_BACKEND: str = REDIS_URL

    # Log directories
    LOG_DIR: str = "logs"

    # Channel Integrations (WhatsApp / Email / Telephone)
    WHATSAPP_VERIFY_TOKEN: str = ""
    INTEGRATION_WEBHOOK_SECRET: str = ""

    # Team Chat — AES-256-GCM encryption key(s) for message content/attachments at rest.
    # Never stored in the DB or source; see app/core/chat_encryption.py for the key-rotation contract.
    CHAT_ENCRYPTION_KEY: str = ""
    CHAT_ENCRYPTION_KEYS: str = ""  # "1:base64key1,2:base64key2" — set when rotating
    CHAT_ENCRYPTION_ACTIVE_KEY_VERSION: str = ""
    CHAT_MAX_MESSAGE_LENGTH: int = 8000
    CHAT_MAX_ATTACHMENT_MB: int = 25
    CHAT_ALLOWED_ATTACHMENT_EXTS: str = (
        "jpg,jpeg,png,gif,webp,pdf,doc,docx,xls,xlsx,ppt,pptx,csv,txt"
    )

    model_config = {
        "env_file": str(BASE_DIR / ".env"),
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
