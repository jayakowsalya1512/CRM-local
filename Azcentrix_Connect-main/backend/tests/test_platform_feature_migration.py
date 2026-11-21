import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

os.environ.setdefault("DEBUG", "false")

from app.database import Base
from app.models.tenant import Feature, PlanFeature, TenantFeature
from app.routers.platform_router import migrate_legacy_feature_keys


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine)
    return SessionLocal()


def test_legacy_document_management_feature_assignment_is_preserved_when_canonical_row_exists():
    db = _session()
    try:
        old_feature = Feature(
            key="document_management",
            name="Document Management",
            module=None,
        )
        new_feature = Feature(
            key="document_management.view",
            name="Document Management",
            module=None,
        )
        db.add_all([old_feature, new_feature])
        db.flush()

        db.add(PlanFeature(plan_id=1, feature_id=old_feature.id, enabled=True))
        db.add(TenantFeature(tenant_id=1, feature_id=old_feature.id, enabled=True))
        db.flush()

        migrate_legacy_feature_keys(db)
        db.flush()

        assert db.query(Feature).filter(Feature.key == "document_management").first() is None
        assert db.query(PlanFeature).filter(
            PlanFeature.plan_id == 1,
            PlanFeature.feature_id == new_feature.id,
            PlanFeature.enabled == True,
        ).first() is not None
        assert db.query(TenantFeature).filter(
            TenantFeature.tenant_id == 1,
            TenantFeature.feature_id == new_feature.id,
            TenantFeature.enabled == True,
        ).first() is not None
    finally:
        db.close()


def test_legacy_feature_migration_keeps_enabled_assignment_when_duplicate_exists():
    db = _session()
    try:
        old_feature = Feature(key="rfp", name="RFP", module=None)
        new_feature = Feature(key="rfp.view", name="RFP Analysis", module=None)
        db.add_all([old_feature, new_feature])
        db.flush()

        db.add(PlanFeature(plan_id=1, feature_id=old_feature.id, enabled=True))
        db.add(PlanFeature(plan_id=1, feature_id=new_feature.id, enabled=False))
        db.add(TenantFeature(tenant_id=1, feature_id=old_feature.id, enabled=True))
        db.add(TenantFeature(tenant_id=1, feature_id=new_feature.id, enabled=False))
        db.flush()

        migrate_legacy_feature_keys(db)
        db.flush()

        assert db.query(PlanFeature).filter(
            PlanFeature.plan_id == 1,
            PlanFeature.feature_id == new_feature.id,
        ).one().enabled is True
        assert db.query(TenantFeature).filter(
            TenantFeature.tenant_id == 1,
            TenantFeature.feature_id == new_feature.id,
        ).one().enabled is True
    finally:
        db.close()
