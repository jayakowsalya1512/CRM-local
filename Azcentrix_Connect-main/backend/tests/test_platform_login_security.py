import os
from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("DEBUG", "false")

from app.core.security import hash_password
from app.database import Base, get_master_db_dep
from app.models.tenant import PlatformSession, PlatformSetting, SuperAdmin
from app.routers import platform_router
from app.services import platform_login_security as ls
from app.services import platform_password_policy as password_policy

PASSWORD = "Str0ng!Passw0rd"
DEVICE = "device-a"


@pytest.fixture
def env(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(password_policy, "master_engine", engine)
    monkeypatch.setattr(password_policy, "_ready", {})
    SessionLocal = sessionmaker(bind=engine)
    ls._tables_ready = False

    db = SessionLocal()
    db.add(SuperAdmin(id=1, username="root", email="root@example.com", full_name="Root", hashed_password=hash_password(PASSWORD), is_active=True))
    db.commit()

    sent = {}
    monkeypatch.setattr(ls, "_send_otp_email", lambda admin, code, minutes: sent.__setitem__("otp", code))

    app = FastAPI()
    app.include_router(platform_router.router, prefix="/platform")

    def override():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_master_db_dep] = override
    client = TestClient(app)

    def set_policy(**fields):
        policy = ls.get_policy(db)
        for key, value in fields.items():
            setattr(policy, key, value)
        db.commit()

    yield {"client": client, "db": db, "sent": sent, "set_policy": set_policy}
    db.close()


def _login(client, **extra):
    return client.post("/platform/login", json={"username": "root", "password": PASSWORD, "device_id": DEVICE, **extra})


def _answer(captcha):
    left, right = captcha["question"].split("=")[0].split("+")
    return str(int(left) + int(right))


def _sessions(db):
    db.expire_all()
    return db.query(PlatformSession).count()


def test_no_policy_logs_in_directly(env):
    res = _login(env["client"])
    assert res.status_code == 200 and res.json()["access_token"]
    assert _sessions(env["db"]) == 1


def test_captcha_is_enforced_server_side_and_single_use(env):
    env["set_policy"](captcha_mode="every_login")
    client = env["client"]

    res = _login(client)
    assert res.status_code == 400 and res.json()["detail"]["code"] == "captcha_required"

    # A client-side "verified" flag is not accepted.
    res = _login(client, captcha_id="fake", captcha_answer="verified")
    assert res.status_code == 400 and res.json()["detail"]["code"] == "captcha_invalid"

    cap = client.post("/platform/login/captcha").json()
    res = _login(client, captcha_id=cap["captcha_id"], captcha_answer="999")
    assert res.json()["detail"]["code"] == "captcha_invalid"
    # The wrong guess burned it, so the right answer no longer works either.
    res = _login(client, captcha_id=cap["captcha_id"], captcha_answer=_answer(cap))
    assert res.json()["detail"]["code"] == "captcha_invalid"

    cap = client.post("/platform/login/captcha").json()
    res = _login(client, captcha_id=cap["captcha_id"], captcha_answer=_answer(cap))
    assert res.status_code == 200 and res.json()["access_token"]


def test_captcha_expires(env):
    env["set_policy"](captcha_mode="every_login")
    client, db = env["client"], env["db"]
    cap = client.post("/platform/login/captcha").json()
    row = db.get(ls.PlatformLoginChallenge, cap["captcha_id"])
    row.expires_at = datetime.utcnow() - timedelta(seconds=1)
    db.commit()
    res = _login(client, captcha_id=cap["captcha_id"], captcha_answer=_answer(cap))
    assert res.json()["detail"]["code"] == "captcha_invalid"


def test_otp_required_before_any_session(env):
    env["set_policy"](otp_mode="every_login")
    client, db = env["client"], env["db"]

    res = _login(client)
    body = res.json()
    assert res.status_code == 200 and body["otp_required"] and "access_token" not in body
    assert body["otp_destination"] == "ro***@example.com"
    assert _sessions(db) == 0

    bad = client.post("/platform/login/verify-otp", json={"challenge_id": body["challenge_id"], "otp": "000000" if env["sent"]["otp"] != "000000" else "111111", "device_id": DEVICE})
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "otp_invalid"
    assert _sessions(db) == 0

    ok = client.post("/platform/login/verify-otp", json={"challenge_id": body["challenge_id"], "otp": env["sent"]["otp"], "device_id": DEVICE})
    assert ok.status_code == 200 and ok.json()["access_token"]
    assert _sessions(db) == 1

    replay = client.post("/platform/login/verify-otp", json={"challenge_id": body["challenge_id"], "otp": env["sent"]["otp"], "device_id": DEVICE})
    assert replay.status_code == 401


def test_otp_attempt_limit_kills_challenge(env):
    env["set_policy"](otp_mode="every_login", otp_max_attempts=3)
    client = env["client"]
    challenge_id = _login(client).json()["challenge_id"]
    wrong = "000000" if env["sent"]["otp"] != "000000" else "111111"
    codes = [client.post("/platform/login/verify-otp", json={"challenge_id": challenge_id, "otp": wrong, "device_id": DEVICE}).status_code for _ in range(3)]
    assert codes == [400, 400, 429]
    res = client.post("/platform/login/verify-otp", json={"challenge_id": challenge_id, "otp": env["sent"]["otp"], "device_id": DEVICE})
    assert res.status_code == 401
    assert _sessions(env["db"]) == 0


def test_otp_expiry(env):
    env["set_policy"](otp_mode="every_login")
    client, db = env["client"], env["db"]
    challenge_id = _login(client).json()["challenge_id"]
    row = db.get(ls.PlatformLoginChallenge, challenge_id)
    row.otp_expires_at = datetime.utcnow() - timedelta(seconds=1)
    db.commit()
    res = client.post("/platform/login/verify-otp", json={"challenge_id": challenge_id, "otp": env["sent"]["otp"], "device_id": DEVICE})
    assert res.status_code == 400 and res.json()["detail"]["code"] == "otp_expired"


def test_resend_cooldown_and_limit(env):
    env["set_policy"](otp_mode="every_login", otp_max_resends=1, otp_resend_cooldown_seconds=30)
    client, db = env["client"], env["db"]
    challenge_id = _login(client).json()["challenge_id"]
    first_code = env["sent"]["otp"]

    res = client.post("/platform/login/resend-otp", json={"challenge_id": challenge_id, "device_id": DEVICE})
    assert res.status_code == 429 and res.json()["detail"]["code"] == "otp_resend_cooldown"

    row = db.get(ls.PlatformLoginChallenge, challenge_id)
    row.last_sent_at = datetime.utcnow() - timedelta(seconds=31)
    db.commit()
    assert client.post("/platform/login/resend-otp", json={"challenge_id": challenge_id, "device_id": DEVICE}).status_code == 200

    db.expire_all()
    row = db.get(ls.PlatformLoginChallenge, challenge_id)
    row.last_sent_at = datetime.utcnow() - timedelta(seconds=31)
    db.commit()
    res = client.post("/platform/login/resend-otp", json={"challenge_id": challenge_id, "device_id": DEVICE})
    assert res.status_code == 429 and res.json()["detail"]["code"] == "otp_resend_limit"

    if first_code != env["sent"]["otp"]:
        old = client.post("/platform/login/verify-otp", json={"challenge_id": challenge_id, "otp": first_code, "device_id": DEVICE})
        assert old.status_code == 400


def test_challenge_is_bound_to_device(env):
    env["set_policy"](otp_mode="every_login")
    client = env["client"]
    challenge_id = _login(client).json()["challenge_id"]
    res = client.post("/platform/login/verify-otp", json={"challenge_id": challenge_id, "otp": env["sent"]["otp"], "device_id": "other-device"})
    assert res.status_code == 401
    assert _sessions(env["db"]) == 0


def test_password_change_cannot_skip_otp(env):
    env["set_policy"](otp_mode="every_login")
    client, db = env["client"], env["db"]
    db.add(PlatformSetting(key="platform_first_change_1", value_bool=True))
    db.commit()

    body = _login(client).json()
    assert body["otp_required"] and body["password_change_required"]
    skip = client.post("/platform/login/change-password", json={"challenge_id": body["challenge_id"], "new_password": "N3w!Passw0rdX", "device_id": DEVICE})
    assert skip.status_code == 403
    assert _sessions(db) == 0

    step = client.post("/platform/login/verify-otp", json={"challenge_id": body["challenge_id"], "otp": env["sent"]["otp"], "device_id": DEVICE}).json()
    assert step["password_change_required"] and "access_token" not in step
    assert _sessions(db) == 0

    done = client.post("/platform/login/change-password", json={"challenge_id": body["challenge_id"], "new_password": "N3w!Passw0rdX", "device_id": DEVICE})
    assert done.status_code == 200 and done.json()["access_token"]
    assert _sessions(db) == 1


def test_password_lockout(env):
    client = env["client"]
    for _ in range(ls.lockout_policy(env["db"])[0]):
        assert client.post("/platform/login", json={"username": "root", "password": "nope", "device_id": DEVICE}).status_code == 401
    res = _login(client)
    assert res.status_code == 429 and res.json()["detail"]["code"] == "locked"


def test_after_failed_captcha(env):
    env["set_policy"](captcha_mode="after_failed")
    client = env["client"]
    for _ in range(ls.CAPTCHA_AFTER_FAILURES - 1):
        res = client.post("/platform/login", json={"username": "root", "password": "nope", "device_id": DEVICE})
        assert res.json()["detail"]["captcha_required"] is False
    res = client.post("/platform/login", json={"username": "root", "password": "nope", "device_id": DEVICE})
    assert res.json()["detail"]["captcha_required"] is True
    assert _login(client).json()["detail"]["code"] == "captcha_required"


def test_new_device_otp_only_once_per_trusted_device(env):
    env["set_policy"](otp_mode="new_device")
    client = env["client"]
    body = _login(client).json()
    assert body["otp_required"]
    client.post("/platform/login/verify-otp", json={"challenge_id": body["challenge_id"], "otp": env["sent"]["otp"], "device_id": DEVICE, "trust_device": True})
    again = _login(client).json()
    assert again.get("access_token") and not again.get("otp_required")
    other = client.post("/platform/login", json={"username": "root", "password": PASSWORD, "device_id": "device-b"}).json()
    assert other["otp_required"]


def _verify(env, body, trust):
    return env["client"].post("/platform/login/verify-otp", json={"challenge_id": body["challenge_id"], "otp": env["sent"]["otp"], "device_id": DEVICE, "trust_device": trust})


def _trusted(db):
    db.expire_all()
    return db.query(ls.PlatformTrustedDevice).all()


def test_untrusted_device_gets_otp_again(env):
    env["set_policy"](otp_mode="new_device")
    res = _verify(env, _login(env["client"]).json(), False)
    assert res.json()["access_token"] and _trusted(env["db"]) == []
    assert _login(env["client"]).json()["otp_required"]


def test_trust_lasts_30_days_and_restarts_on_sign_in(env):
    env["set_policy"](otp_mode="new_device")
    _verify(env, _login(env["client"]).json(), True)
    (row,) = _trusted(env["db"])
    assert timedelta(days=29, hours=23) < row.trusted_until - datetime.utcnow() <= timedelta(days=30)
    row.trusted_until = datetime.utcnow() - timedelta(seconds=1)      # 30 days passed
    env["db"].commit()
    body = _login(env["client"]).json()
    assert body["otp_required"]
    _verify(env, body, False)                                         # unticked this time → trust removed
    assert _trusted(env["db"]) == []


def test_unticking_revokes_existing_trust_in_every_login_mode(env):
    env["set_policy"](otp_mode="every_login")
    _verify(env, _login(env["client"]).json(), True)
    assert len(_trusted(env["db"])) == 1
    _verify(env, _login(env["client"]).json(), False)
    assert _trusted(env["db"]) == []


def test_sign_in_without_otp_remembers_device_for_30_days(env):
    res = _login(env["client"])
    assert res.json()["access_token"]
    (row,) = _trusted(env["db"])
    assert row.trusted_until > datetime.utcnow() + timedelta(days=29)


def test_legacy_remembered_device_is_migrated_with_expiry(env):
    env["set_policy"](otp_mode="new_device")
    db = env["db"]
    db.add(PlatformSetting(key=platform_router._platform_device_key(1, ls.hash_device(DEVICE)), value_bool=True))
    db.commit()
    res = _login(env["client"]).json()
    assert res.get("access_token")                                     # still known: no OTP
    db.expire_all()
    assert db.query(PlatformSetting).filter(PlatformSetting.key.like("platform_device_%")).count() == 0
    (row,) = _trusted(db)
    assert row.trusted_until > datetime.utcnow() + timedelta(days=29)


def test_trust_choice_carries_through_password_change(env):
    env["set_policy"](otp_mode="every_login")
    env["db"].add(PlatformSetting(key="platform_first_change_1", value_bool=True))
    env["db"].commit()
    body = _verify(env, _login(env["client"]).json(), True).json()
    assert body["password_change_required"] and _trusted(env["db"]) == []
    res = env["client"].post("/platform/login/change-password", json={"challenge_id": body["challenge_id"], "new_password": "N3w!Passw0rd#2026",
                                                                      "device_id": DEVICE, "trust_device": True})
    assert res.status_code == 200 and res.json()["access_token"] and len(_trusted(env["db"])) == 1


def test_login_status_is_public_and_minimal(env, monkeypatch):
    platform_router._login_status_cache.clear()
    from app.services import platform_infrastructure, platform_rate_limits
    monkeypatch.setattr(platform_infrastructure, "server_inventory", lambda: [{"name": "a", "region": "Mumbai"}, {"name": "b", "region": "Mumbai"}, {"name": "c"}])
    monkeypatch.setattr(platform_rate_limits, "p95_ms", lambda db: 184)
    res = env["client"].get("/platform/login/status")
    assert res.status_code == 200 and res.json() == {"operational": True, "regions": 2, "p95_ms": 184}
    platform_router._login_status_cache.clear()


def test_contact_administrator_is_logged_and_rate_limited(env, monkeypatch):
    from app.models.tenant import PlatformAuditLog
    sent = []
    monkeypatch.setattr(platform_router, "_send_contact_admin_email", lambda recipients, ref, data, ip, ua: sent.append((recipients, ref)))
    monkeypatch.setattr(platform_router.settings, "SMTP_HOST", "smtp.test")
    monkeypatch.setattr(platform_router.settings, "SMTP_USER", "u")
    monkeypatch.setattr(platform_router.settings, "SMTP_PASSWORD", "p")
    client = env["client"]
    assert client.post("/platform/login/contact-administrator", json={"contact": "Riya", "category": "Something else", "message": ""}).status_code == 422
    assert client.post("/platform/login/contact-administrator", json={"contact": "   ", "category": "I’m locked out"}).status_code == 422
    res = client.post("/platform/login/contact-administrator", json={"contact": " riya@x.in ", "category": "I’m locked out", "message": "Locked after travel"})
    assert res.status_code == 201
    body = res.json()
    assert body["reference"].startswith("SEC-") and body["notified"] and sent == [(["root@example.com"], body["reference"])]
    env["db"].expire_all()
    log = env["db"].query(PlatformAuditLog).filter(PlatformAuditLog.action == "platform_contact_administrator").one()
    assert log.new_data == {"contact": "riya@x.in", "category": "I’m locked out", "message": "Locked after travel", "reference": body["reference"]}
    for _ in range(4):
        assert client.post("/platform/login/contact-administrator", json={"contact": "x", "category": "I need platform access"}).status_code == 201
    assert client.post("/platform/login/contact-administrator", json={"contact": "x", "category": "I need platform access"}).status_code == 429


def test_forgot_password_accepts_user_name_or_email(env, monkeypatch):
    env["db"].add(PlatformSetting(key=platform_router.PLATFORM_FORGOT_PASSWORD_KEY, value_bool=True))
    env["db"].commit()
    sent = []
    monkeypatch.setattr(platform_router, "_send_platform_reset_email", lambda admin, token: sent.append(admin.username))
    client = env["client"]
    for ident in ("root", "ROOT@example.com", "nobody", "nobody@example.com"):
        res = client.post("/platform/forgot-password", json={"email": ident})
        assert res.status_code == 200 and "If an active Platform account matches" in res.json()["message"]   # same answer either way
    assert sent == ["root", "root"]
