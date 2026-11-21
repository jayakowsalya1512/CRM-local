from datetime import date, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.models.all_models import AuditLog, Customer, Lead, Tender, OEM, LetterTemplate, DocumentManagementFile, DocumentTrash, DocumentShare, DocumentStar, User
from app.routers.recycle_bin_router import list_recycle_bin, _mutate, _bulk, BulkRequest


@pytest.fixture
def db():
    engine = create_engine('sqlite:///:memory:')
    for model in (User, AuditLog, Customer, Lead, Tender, OEM, LetterTemplate, DocumentManagementFile, DocumentTrash, DocumentShare, DocumentStar):
        model.__table__.create(engine)
    with Session(engine) as session:
        yield session


def listing(db, **kwargs):
    args = dict(module=None, search=None, view='deleted', page=1, limit=25, deleted_by=None, date_from=None, date_to=None, db=db, _=None)
    args.update(kwargs)
    return list_recycle_bin(**args)


def test_full_counts_pagination_filters_and_real_timestamps(db):
    db.add_all([OEM(name=f'OEM {i}', is_deleted=True) for i in range(125)])
    db.flush()
    db.add(AuditLog(module='oems', action='delete', record_id=1, user_id=9, created_at=datetime(2026, 9, 1, 23, 59)))
    db.commit()
    first = listing(db)
    assert first['total'] == first['counts']['oems'] == 125
    assert len(first['items']) == 25
    assert first['items'][0]['deleted_at'] == '2026-09-01T23:59:00+05:30'
    assert first['items'][1]['deleted_at'] is None
    second = listing(db, page=2)
    assert not set(i['id'] for i in first['items']) & set(i['id'] for i in second['items'])
    assert listing(db, deleted_by=9, date_from=date(2026, 9, 1), date_to=date(2026, 9, 1))['total'] == 1
    assert listing(db, search='OEM 124')['total'] == 1
    assert listing(db, search='%')['total'] == 0


def test_documents_search_before_paging_and_no_duplicate_markers(db):
    db.add(DocumentManagementFile(name='Needle', description='special', file_url='/media/test', deleted_at=datetime(2026, 9, 1)))
    db.add(DocumentTrash(document_id='standalone:0:1:uploaded_document'))
    db.add(DocumentTrash(document_id='tenders:1:2:proposal'))
    db.commit()
    assert listing(db)['total'] == 2
    assert listing(db, search='special', limit=1)['items'][0]['record_id'] == 'standalone:0:1:uploaded_document'


def test_restored_counts_and_filters_not_limited_to_first_100(db):
    db.add_all([AuditLog(module='oems', action=' Restore ', record_id=i, description=f'Restored {i}', created_at=datetime(2026, 9, 1)) for i in range(125)])
    db.commit()
    data = listing(db, view='restored', page=5)
    assert data['total'] == data['restored_count'] == 125
    assert len(data['items']) == 25
    assert listing(db, view='restored', search='Restored 124')['total'] == 1


USER = SimpleNamespace(id=1)
REQUEST = Request({'type': 'http', 'headers': [], 'client': ('127.0.0.1', 1234)})


def test_bulk_partial_failure_and_audit(db):
    db.add(OEM(name='Restore me', is_deleted=True))
    db.commit()
    result = _bulk(BulkRequest(items=[{'module_key': 'oems', 'record_id': '1'}, {'module_key': 'oems', 'record_id': '999'}]), 'restore', db, USER, REQUEST)
    assert [row['success'] for row in result['results']] == [True, False]
    assert db.get(OEM, 1).is_deleted is False
    log = db.query(AuditLog).one()
    assert log.action == 'restore' and log.old_data['title'] == 'Restore me'
    with pytest.raises(HTTPException):
        _mutate(db, 'oems', '1', 'delete', USER, REQUEST)


def test_failed_audit_rolls_back_restore(db):
    db.add(OEM(name='Keep trashed', is_deleted=True))
    db.commit()
    def fail_audit(mapper, connection, target):
        raise RuntimeError('audit unavailable')
    event.listen(AuditLog, 'before_insert', fail_audit)
    try:
        with pytest.raises(RuntimeError):
            _mutate(db, 'oems', '1', 'restore', USER, REQUEST)
        db.rollback()
        assert db.get(OEM, 1).is_deleted is True
    finally:
        event.remove(AuditLog, 'before_insert', fail_audit)


def test_linked_document_permanent_delete_cannot_be_restored(db):
    db.add(DocumentTrash(document_id='tenders:1:2:proposal'))
    db.commit()
    _mutate(db, 'document_management', 'tenders:1:2:proposal', 'delete', USER, REQUEST)
    assert listing(db)['total'] == 0
    assert db.query(AuditLog).one().old_data['record_id'] == 'tenders:1:2:proposal'
    with pytest.raises(HTTPException):
        _mutate(db, 'document_management', 'tenders:1:2:proposal', 'restore', USER, REQUEST)


def test_bulk_delete_summary_only_contains_successful_records(db):
    db.add(OEM(name='Delete me', is_deleted=True))
    db.commit()
    payload = BulkRequest(items=[{'module_key': 'oems', 'record_id': '1'},
                                 {'module_key': 'oems', 'record_id': '999'}])
    result = _bulk(payload, 'delete', db, USER, REQUEST)
    assert [row['success'] for row in result['results']] == [True, False]
    summary = db.query(AuditLog).filter_by(action='bulk_delete').one()
    assert summary.new_data['failed_count'] == 1
    assert [row['record_id'] for row in summary.new_data['deleted']] == ['1']
    assert db.query(AuditLog).filter_by(action='permanent_delete').count() == 1
    _bulk(payload, 'delete', db, USER, REQUEST)
    assert db.query(AuditLog).filter_by(action='bulk_delete').count() == 1
