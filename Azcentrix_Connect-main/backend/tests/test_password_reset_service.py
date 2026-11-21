from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.core.security import create_password_reset_token, verify_password_reset_token
from app.services.password_reset_service import (
    PASSWORD_RESET_PURPOSE_ADMIN,
    PASSWORD_RESET_PURPOSE_FORGOT_PASSWORD,
    _password_reset_counts_toward_self_service_limit,
    _refresh_reset_window,
)


def _tenant(days: int = 30) -> SimpleNamespace:
    return SimpleNamespace(self_service_reset_limit_days=days)


def _user(*, reset_window_start=None, reset_count: int = 0) -> SimpleNamespace:
    return SimpleNamespace(reset_window_start=reset_window_start, reset_count=reset_count)


def test_refresh_reset_window_does_not_start_window_during_link_request():
    now = datetime.now(timezone.utc)
    user = _user(reset_window_start=None, reset_count=0)

    changed = _refresh_reset_window(user, _tenant(), now, initialize_if_missing=False)

    assert changed is False
    assert user.reset_window_start is None
    assert user.reset_count == 0


def test_refresh_reset_window_clears_expired_window_until_reset_is_completed():
    old_start = datetime.now(timezone.utc) - timedelta(days=31)
    now = datetime.now(timezone.utc)
    user = _user(reset_window_start=old_start, reset_count=2)

    changed = _refresh_reset_window(user, _tenant(), now, initialize_if_missing=False)

    assert changed is True
    assert user.reset_window_start is None
    assert user.reset_count == 0


def test_refresh_reset_window_starts_new_window_when_reset_is_completed():
    now = datetime.now(timezone.utc)
    user = _user(reset_window_start=None, reset_count=0)

    changed = _refresh_reset_window(user, _tenant(), now, initialize_if_missing=True)

    assert changed is True
    assert user.reset_window_start == now
    assert user.reset_count == 0


def test_only_forgot_password_tokens_consume_self_service_reset_limit():
    forgot_payload = verify_password_reset_token(
        create_password_reset_token(
            user_id=1,
            tenant_id=1,
            tenant_slug="demo",
            email="user@example.com",
            password_fingerprint="fingerprint",
            purpose=PASSWORD_RESET_PURPOSE_FORGOT_PASSWORD,
        )
    )
    admin_payload = verify_password_reset_token(
        create_password_reset_token(
            user_id=1,
            tenant_id=1,
            tenant_slug="demo",
            email="user@example.com",
            password_fingerprint="fingerprint",
            purpose=PASSWORD_RESET_PURPOSE_ADMIN,
        )
    )

    assert _password_reset_counts_toward_self_service_limit(forgot_payload) is True
    assert _password_reset_counts_toward_self_service_limit(admin_payload) is False
    assert _password_reset_counts_toward_self_service_limit({}) is True
