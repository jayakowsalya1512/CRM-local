from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.timezone import now_ist
from app.models.all_models import Notification, StickyNote, User
from app.routers.sticky_notes_router import NoteInput, NoteUpdate, create_note, delete_note, list_notes, update_note
from app.services.sticky_note_service import deliver_due_reminders


@pytest.fixture
def db():
    engine = create_engine('sqlite:///:memory:')
    for model in (User, StickyNote, Notification):
        model.__table__.create(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


OWNER = SimpleNamespace(id=1, role='sales')
OTHER = SimpleNamespace(id=2, role='admin')


def test_crud_and_owner_isolation(db):
    note = create_note(NoteInput(title='Call customer', content='<b>Tomorrow</b>', color='blue'), db, OWNER)
    assert list_notes(db, OWNER)[0]['title'] == 'Call customer'
    assert list_notes(db, OTHER) == []
    with pytest.raises(HTTPException) as denied:
        update_note(note['id'], NoteUpdate(title='Stolen', version=1), db, OTHER)
    assert denied.value.status_code == 404
    with pytest.raises(HTTPException) as denied:
        delete_note(note['id'], db, OTHER)
    assert denied.value.status_code == 404
    updated = update_note(note['id'], NoteUpdate(title='Follow up', content='Done', pinned=True, version=1), db, OWNER)
    assert updated['version'] == 2 and updated['pinned']
    with pytest.raises(HTTPException) as conflict:
        update_note(note['id'], NoteUpdate(title='Old tab', version=1), db, OWNER)
    assert conflict.value.status_code == 409
    assert list_notes(db, OWNER)[0]['title'] == 'Follow up'
    delete_note(note['id'], db, OWNER)
    assert list_notes(db, OWNER) == []


def test_html_is_formatting_only_and_input_is_bounded(db):
    note = create_note(NoteInput(content='<b onclick="evil()">Bold</b><img src=x onerror=evil()><a href="javascript:evil()">Link</a><script>evil()</script>'), db, OWNER)
    assert note['content'] == '<b>Bold</b>Linkevil()'
    for payload in ({'color': 'red'}, {'content': 'x' * 50001}, {'title': 'x' * 161}):
        with pytest.raises(ValidationError):
            NoteInput(**payload)
    with pytest.raises(HTTPException):
        create_note(NoteInput(reminder_at=now_ist() - timedelta(minutes=1)), db, OWNER)
    with pytest.raises(HTTPException) as too_large:
        create_note(NoteInput(content='\U0001f600' * 16000), db, OWNER)
    assert too_large.value.status_code == 422


def test_reminders_are_once_per_schedule_and_private(db, monkeypatch):
    from app.services import sticky_note_service
    from app.routers import notifications_router
    monkeypatch.setattr(sticky_note_service, 'invalidate_notifications_cache', lambda *args: None)
    monkeypatch.setattr(notifications_router, '_unread_count', lambda *args: 0)
    note = create_note(NoteInput(title='Private follow-up', reminder_at=now_ist() + timedelta(hours=1)), db, OWNER)
    row = db.get(StickyNote, note['id'])
    row.reminder_at = now_ist() - timedelta(minutes=1)
    db.commit()
    assert deliver_due_reminders(db) == 1
    assert deliver_due_reminders(db) == 0
    notification = db.query(Notification).one()
    assert notification.user_id == OWNER.id and notification.message == 'Private follow-up'
    assert notifications_router.list_notifications(False, False, None, 50, db, OTHER)['items'] == []
    assert len(notifications_router.list_notifications(False, False, None, 50, db, OWNER)['items']) == 1
    update_note(note['id'], NoteUpdate(title='Next reminder', version=1, reminder_at=now_ist() + timedelta(hours=2)), db, OWNER)
    row.reminder_at = now_ist() - timedelta(minutes=1)
    db.commit()
    assert deliver_due_reminders(db) == 1
    assert db.query(Notification).count() == 1
    assert db.query(Notification).one().message == 'Next reminder'


def test_tenant_databases_are_isolated(db):
    create_note(NoteInput(title='Tenant A secret'), db, OWNER)
    engine = create_engine('sqlite:///:memory:')
    for model in (User, StickyNote):
        model.__table__.create(engine)
    with Session(engine) as other_tenant:
        assert list_notes(other_tenant, OWNER) == []
    engine.dispose()
