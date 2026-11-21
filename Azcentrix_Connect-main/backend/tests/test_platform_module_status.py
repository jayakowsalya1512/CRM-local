import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("DEBUG", "false")

from app.database import Base, get_master_db_dep
from app.models.tenant import Feature, Plan, PlanFeature, Tenant, TenantFeature
from app.routers import platform_router
from app.services.platform_access import enforce_platform_access
from app.services import platform_module_status as ms


@pytest.fixture
def client(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine)
    ms._table_ready = False
    db = SessionLocal()
    db.add(Feature(id=1, key="dashboard.customers.view", name="Customers dashboard", module="Dashboard"))
    db.commit()
    app = FastAPI()
    app.include_router(platform_router.protected_router, prefix="/platform")
    monkeypatch.setattr(platform_router, "_get_platform_admin", lambda request: None)

    def override():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_master_db_dep] = override
    app.dependency_overrides[platform_router.require_platform_super_admin] = lambda: None
    app.dependency_overrides[enforce_platform_access] = lambda: None
    yield TestClient(app), db
    db.close()


def _status(client, key):
    return next(item for item in client.get("/platform/services").json() if item["key"] == key)["is_active"]


def test_every_item_has_a_boolean_status(client):
    c, _ = client
    items = c.get("/platform/services").json()
    assert items and all(isinstance(item["is_active"], bool) for item in items)
    assert any(item["id"] is None for item in items)  # "Not linked" items are included


def test_not_linked_item_can_be_toggled_independently(client):
    c, _ = client
    assert c.put("/platform/services/status", json={"key": "settings.theme", "is_active": False}).status_code == 200
    assert _status(c, "settings.theme") is False
    assert _status(c, "settings") is True          # parent unchanged
    assert _status(c, "settings.company") is True  # sibling unchanged


def test_parent_toggle_does_not_overwrite_children(client):
    c, _ = client
    c.put("/platform/services/status", json={"key": "dashboard", "is_active": False})
    assert _status(c, "dashboard") is False
    assert _status(c, "dashboard.customers") is True


def test_unknown_key_is_rejected(client):
    c, _ = client
    assert c.put("/platform/services/status", json={"key": "nope", "is_active": False}).status_code == 404


def test_onboarding_visibility_hides_inactive_and_children_of_inactive(client):
    c, _ = client
    assert c.get("/platform/services/onboarding-visibility").json()["hidden_feature_keys"] == []
    c.put("/platform/services/status", json={"key": "dashboard.customers", "is_active": False})
    assert "dashboard.customers.view" in c.get("/platform/services/onboarding-visibility").json()["hidden_feature_keys"]
    c.put("/platform/services/status", json={"key": "dashboard.customers", "is_active": True})
    c.put("/platform/services/status", json={"key": "dashboard", "is_active": False})
    assert "dashboard.customers.view" in c.get("/platform/services/onboarding-visibility").json()["hidden_feature_keys"]


def test_toggling_never_touches_tenant_or_plan_features(client):
    c, db = client
    db.add(Plan(id=1, name="Core", slug="core"))
    db.add(PlanFeature(plan_id=1, feature_id=1, enabled=True))
    db.add(TenantFeature(tenant_id=1, feature_id=1, enabled=True))
    db.commit()
    c.put("/platform/services/status", json={"key": "dashboard.customers", "is_active": False})
    db.expire_all()
    assert db.query(PlanFeature).filter_by(feature_id=1, enabled=True).count() == 1
    assert db.query(TenantFeature).filter_by(feature_id=1, enabled=True).count() == 1
