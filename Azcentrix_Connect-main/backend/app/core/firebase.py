"""Firebase Admin SDK initialization."""

from __future__ import annotations

import logging
from pathlib import Path

from app.core.config import BASE_DIR, settings

logger = logging.getLogger(__name__)


class FirebaseConfigurationError(RuntimeError):
    """Raised when Firebase credentials are not available or invalid."""


def _service_account_path() -> Path:
    configured_path = Path(settings.FIREBASE_SERVICE_ACCOUNT_PATH)
    if configured_path.is_absolute():
        return configured_path
    return BASE_DIR / configured_path


def get_firebase_app():
    """Return the default Firebase app, initializing it once if needed."""
    try:
        import firebase_admin
        from firebase_admin import credentials
    except ModuleNotFoundError as exc:
        raise FirebaseConfigurationError(
            "firebase-admin is not installed in this Python environment. "
            "Run: python -m pip install firebase-admin"
        ) from exc

    try:
        return firebase_admin.get_app()
    except ValueError:
        pass

    credential_path = _service_account_path()
    if not credential_path.exists():
        raise FirebaseConfigurationError(
            f"Firebase service account file not found: {credential_path}"
        )

    try:
        cred = credentials.Certificate(str(credential_path))
        app = firebase_admin.initialize_app(cred)
        logger.info("Firebase Admin SDK initialized with %s", credential_path)
        return app
    except Exception as exc:
        raise FirebaseConfigurationError(f"Firebase initialization failed: {exc}") from exc
