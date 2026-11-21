from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.all_models import Module, Permission, Role, RolePermission
from app.services.tenant_module_service import (
    get_seed_permissions_for_enabled_features,
    sync_tenant_runtime_catalog,
)


def _session():
    engine = create_engine("sqlite:///:memory:")
    for table in (Role.__table__, Permission.__table__, Module.__table__, RolePermission.__table__):
        table.create(bind=engine)
    SessionLocal = sessionmaker(bind=engine)
    return SessionLocal()


def _granted_keys(db, role):
    rows = (
        db.query(Permission.key)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .filter(RolePermission.role_id == role.id)
        .all()
    )
    return {row[0] for row in rows}


def test_questionnaire_permissions_are_not_seeded_when_platform_feature_is_disabled():
    keys = {
        key
        for key, _, _, _ in get_seed_permissions_for_enabled_features(["customers.view"])
    }

    assert "customers.view" in keys
    assert "questionnaire.view" not in keys
    assert "questionnaire.update" not in keys
    assert "document_management.view" not in keys
    assert "letter_management.view" not in keys


def test_document_management_feature_enables_module_and_permission():
    db = _session()
    try:
        admin_role = Role(
            name="admin",
            display_name="Administrator",
            level=100,
            is_system=True,
            is_active=True,
        )
        db.add(admin_role)
        db.flush()

        sync_tenant_runtime_catalog(
            db,
            enabled_feature_keys=["document_management.view"],
            assign_permissions_to_admin_role=True,
        )
        db.flush()

        module = db.query(Module).filter(Module.key == "document_management").one()
        granted_keys = _granted_keys(db, admin_role)

        assert module.is_active is True
        assert module.permission_key == "document_management.view"
        assert {
            "document_management.view",
            "document_management.create",
            "document_management.update",
            "document_management.delete",
            "document_management.export",
        }.issubset(granted_keys)
    finally:
        db.close()


def test_letter_management_feature_enables_module_and_permission():
    db = _session()
    try:
        admin_role = Role(
            name="admin",
            display_name="Administrator",
            level=100,
            is_system=True,
            is_active=True,
        )
        db.add(admin_role)
        db.flush()

        sync_tenant_runtime_catalog(
            db,
            enabled_feature_keys=["letter_management.view"],
            assign_permissions_to_admin_role=True,
        )
        db.flush()

        module = db.query(Module).filter(Module.key == "letter_management").one()
        granted_keys = _granted_keys(db, admin_role)

        assert module.is_active is True
        assert module.permission_key == "letter_management.view"
        assert {
            "letter_management.view",
            "letter_management.create",
            "letter_management.update",
            "letter_management.delete",
            "letter_management.export",
        }.issubset(granted_keys)
    finally:
        db.close()


def test_recycle_bin_feature_enables_module_and_permission():
    db = _session()
    try:
        admin_role = Role(
            name="admin",
            display_name="Administrator",
            level=100,
            is_system=True,
            is_active=True,
        )
        db.add(admin_role)
        db.flush()

        sync_tenant_runtime_catalog(
            db,
            enabled_feature_keys=["recycle_bin.view"],
            assign_permissions_to_admin_role=True,
        )
        db.flush()

        module = db.query(Module).filter(Module.key == "recycle_bin").one()
        granted_keys = _granted_keys(db, admin_role)

        assert module.is_active is True
        assert module.permission_key == "recycle_bin.view"
        assert {
            "recycle_bin.view",
            "recycle_bin.restore",
            "recycle_bin.delete",
        }.issubset(granted_keys)
    finally:
        db.close()


def test_sync_deactivates_questionnaire_module_and_revokes_stale_role_permissions():
    db = _session()
    try:
        admin_role = Role(
            name="admin",
            display_name="Administrator",
            level=100,
            is_system=True,
            is_active=True,
        )
        db.add(admin_role)
        db.flush()

        stale_permissions = [
            Permission(
                key="questionnaire.view",
                module="questionnaire",
                action="view",
                description="View questionnaires",
            ),
            Permission(
                key="questionnaire.update",
                module="questionnaire",
                action="update",
                description="Update questionnaires",
            ),
        ]
        db.add_all(stale_permissions)
        db.flush()
        for permission in stale_permissions:
            db.add(RolePermission(role_id=admin_role.id, permission_id=permission.id))
        db.flush()

        sync_tenant_runtime_catalog(
            db,
            enabled_feature_keys=["customers.view"],
            assign_permissions_to_admin_role=True,
        )
        db.flush()

        questionnaire_module = db.query(Module).filter(Module.key == "questionnaire").one()
        granted_keys = _granted_keys(db, admin_role)

        assert questionnaire_module.is_active is False
        assert "questionnaire.view" not in granted_keys
        assert "questionnaire.update" not in granted_keys
        assert "customers.view" in granted_keys
    finally:
        db.close()
