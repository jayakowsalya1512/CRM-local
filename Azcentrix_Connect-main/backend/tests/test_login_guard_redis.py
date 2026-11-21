import pytest

from app.middleware import login_guard


class FakeRedis:
    def __init__(self, store):
        self.store = store
        self.ttls = {}

    def ping(self):
        return True

    def hgetall(self, key):
        return dict(self.store.get(key, {}))

    def hset(self, key, mapping):
        self.store.setdefault(key, {}).update({name: str(value) for name, value in mapping.items()})

    def hincrby(self, key, field, amount):
        current = int(self.store.setdefault(key, {}).get(field, 0))
        next_value = current + amount
        self.store[key][field] = str(next_value)
        return next_value

    def expire(self, key, ttl):
        self.ttls[key] = ttl

    def delete(self, key):
        self.store.pop(key, None)


class RedisFactory:
    def __init__(self, store):
        self.store = store

    def from_url(self, *_args, **_kwargs):
        return FakeRedis(self.store)


class RedisNamespace:
    pass


@pytest.fixture
def fake_redis(monkeypatch):
    store = {}
    RedisNamespace.Redis = RedisFactory(store)
    monkeypatch.setattr(login_guard, "redis", RedisNamespace)
    monkeypatch.setattr(login_guard, "_redis_client", None)
    monkeypatch.setattr(login_guard, "_redis_retry_after", 0.0)
    monkeypatch.setattr(login_guard.settings, "CAPTCHA_AFTER_ATTEMPTS", 3)
    monkeypatch.setattr(login_guard.settings, "MAX_LOGIN_ATTEMPTS", 5)
    monkeypatch.setattr(login_guard.settings, "LOCKOUT_DURATION_MINUTES", 30)
    return store


def test_login_state_is_tenant_scoped_and_username_normalized(fake_redis):
    login_guard.record_failed_attempt("tenant_a", "  USER@example.com  ")
    login_guard.record_failed_attempt("tenant_a", "user@example.com")
    login_guard.record_failed_attempt("tenant_a", "USER@example.com")

    assert login_guard.get_attempt_count("tenant_a", "user@example.com") == 3
    assert login_guard.requires_captcha("tenant_a", "USER@example.com") is True
    assert login_guard.get_attempt_count("tenant_b", "user@example.com") == 0
    assert login_guard.requires_captcha("tenant_b", "user@example.com") is False


def test_login_state_survives_new_client_and_is_shared(fake_redis, monkeypatch):
    for _ in range(5):
        login_guard.record_failed_attempt("tenant_a", "same@example.com")

    assert login_guard.is_locked_out("tenant_a", "same@example.com") is True

    monkeypatch.setattr(login_guard, "_redis_client", None)

    assert login_guard.is_locked_out("tenant_a", "same@example.com") is True
    assert login_guard.get_remaining_lockout("tenant_a", "same@example.com") > 0


def test_clear_login_state_removes_only_matching_tenant_user(fake_redis):
    login_guard.record_failed_attempt("tenant_a", "same@example.com")
    login_guard.record_failed_attempt("tenant_b", "same@example.com")

    login_guard.clear_login_state("tenant_a", "same@example.com")

    assert login_guard.get_attempt_count("tenant_a", "same@example.com") == 0
    assert login_guard.get_attempt_count("tenant_b", "same@example.com") == 1
