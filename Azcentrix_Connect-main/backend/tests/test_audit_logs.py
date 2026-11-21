from datetime import date, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.dependencies import require_permission
from app.models.all_models import ActivityLog, AuditLog, Module, Permission, Role, RolePermission, User
from app.routers.audit_log_router import ACTION_TAXONOMY, list_audit_logs
from app.services.tenant_module_service import sync_tenant_runtime_catalog


@pytest.fixture
def db():
    engine = create_engine('sqlite:///:memory:')
    for model in (User, AuditLog, ActivityLog, Module, Permission, Role, RolePermission):
        model.__table__.create(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def listing(db, **kwargs):
    args = dict(search='', module='', action='', date_from=None, date_to=None,
                page=1, page_size=50, db=db, current_user=None)
    return list_audit_logs(**(args | kwargs))


def test_filters_pagination_and_deleted_actor(db):
    db.add_all([AuditLog(module='customers', action='update', record_id=i,
                        description=f'Customer {i}', created_at=datetime(2026, 9, 1, 23, 59))
                for i in range(60)])
    db.commit()
    first = listing(db)
    assert first['total'] == 60
    assert len(first['items']) == 50
    second = listing(db, page=2)
    assert len(second['items']) == 10
    assert not {r['id'] for r in first['items']} & {r['id'] for r in second['items']}
    assert first['items'][0]['user_name'] is None
    assert listing(db, search='%')['total'] == 0
    assert listing(db, search='Customer 59')['total'] == 1
    assert listing(db, module='leads')['total'] == 0
    assert listing(db, action='delete')['total'] == 0
    assert listing(db, date_from=date(2026, 9, 1), date_to=date(2026, 9, 1))['total'] == 60
    assert listing(db, date_from=date(2026, 9, 2))['total'] == 0
    with pytest.raises(HTTPException) as error:
        listing(db, date_from=date(2026, 9, 2), date_to=date(2026, 9, 1))
    assert error.value.status_code == 422


def test_platform_toggle_and_role_revocation(db):
    role = Role(name='admin', display_name='Admin', level=100, is_active=True)
    db.add(role)
    db.flush()
    user = SimpleNamespace(role='admin')
    check = require_permission('audit_logs.view')
    sync_tenant_runtime_catalog(db, enabled_feature_keys=['audit_logs.view'])
    db.flush()
    assert check(db=db, current_user=user) is user
    permission = db.query(Permission).filter_by(key='audit_logs.view').one()
    db.query(RolePermission).filter_by(role_id=role.id, permission_id=permission.id).delete()
    db.flush()
    with pytest.raises(HTTPException) as error:
        check(db=db, current_user=user)
    assert error.value.status_code == 403
    sync_tenant_runtime_catalog(db, enabled_feature_keys=['customers.view'])
    db.flush()
    assert not db.query(Module).filter_by(key='audit_logs').one().is_active
    with pytest.raises(HTTPException) as error:
        check(db=db, current_user=user)
    assert error.value.status_code == 403


def test_empty_tenant_has_no_other_tenants_records(db):
    other_engine = create_engine('sqlite:///:memory:')
    for model in (User, AuditLog, Module):
        model.__table__.create(other_engine)
    with Session(other_engine) as other:
        other.add(AuditLog(module='customers', action='create', description='Other tenant'))
        other.commit()
        assert listing(other)['total'] == 1
        assert listing(db)['total'] == 0
    other_engine.dispose()


@pytest.mark.parametrize("action", ACTION_TAXONOMY)
def test_every_action_is_persisted_and_filterable(db, action):
    from app.core.logging import log_module_action
    from decimal import Decimal

    log_module_action(
        db=db, user_id=None, module="customers", action=action,
        record_id=42, record_name="Acme", ip="127.0.0.1",
        old_data={"amount": Decimal("1.25")},
        new_data={"date": date(2026, 9, 12)},
    )
    db.commit()
    db.expire_all()
    result = listing(db, action=action, search="Acme")
    assert result["total"] == 1
    row = result["items"][0]
    assert row["action"] == action
    assert row["old_data"] == {"amount": 1.25}
    assert row["new_data"] == {"date": "2026-09-12"}


def test_approval_logger_accepts_description_without_record_name(db):
    from app.core.logging import log_module_action

    log_module_action(db=db, user_id=None, module="customers", action="approve",
                      record_id=42, description="Approved customer #42")
    db.commit()
    assert listing(db, action="approve")["items"][0]["description"] == "Approved customer #42"


def test_client_export_is_saved(db):
    from starlette.requests import Request
    from app.routers.audit_log_router import ClientAuditEvent, log_client_audit_event

    request = Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1234)})
    log_client_audit_event(
        ClientAuditEvent(module="customers", action="export", description="Exported CSV"),
        request, db, SimpleNamespace(id=None),
    )
    assert listing(db, action="export")["items"][0]["description"] == "Exported CSV"
    with pytest.raises(HTTPException):
        log_client_audit_event(ClientAuditEvent(module="customers", action="delete"),
                              request, db, SimpleNamespace(id=None))
    assert listing(db)["total"] == 1
