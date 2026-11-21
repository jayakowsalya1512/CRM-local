"""Personal notes, scoped to the authenticated user in the current tenant."""
from datetime import datetime
from html import escape
from html.parser import HTMLParser
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.timezone import IST, as_ist_naive, now_ist
from app.dependencies import get_current_user, get_tenant_db
from app.models.all_models import StickyNote, User

router = APIRouter()


class NoteHTML(HTMLParser):
    """Keep only text and basic formatting; never retain attributes or URLs."""
    allowed = {"p", "div", "br", "b", "strong", "i", "em", "u", "s", "strike", "ul", "ol", "li"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in self.allowed:
            self.parts.append(f"<{tag}>")

    def handle_endtag(self, tag):
        if tag in self.allowed and tag != "br":
            self.parts.append(f"</{tag}>")

    def handle_data(self, data):
        self.parts.append(escape(data))


def sanitize_content(content):
    parser = NoteHTML()
    parser.feed(content)
    parser.close()
    return "".join(parser.parts)


def validated_content(content):
    cleaned = sanitize_content(content)
    # MySQL TEXT is byte-limited; formatting escaping and Unicode can expand
    # beyond the input's character count.
    if len(cleaned.encode('utf-8')) > 60000:
        raise HTTPException(422, "This note is too long. Please shorten it before saving.")
    return cleaned


class NoteInput(BaseModel):
    title: str = Field(default="Untitled note", max_length=160)
    content: str = Field(default="", max_length=50000)
    color: Literal["olive", "yellow", "pink", "green", "blue", "lavender"] = "olive"
    pinned: bool = False
    reminder_at: datetime | None = None


class NoteUpdate(NoteInput):
    version: int = Field(ge=1)


def serialize(note):
    def iso(value):
        return value.replace(tzinfo=IST).isoformat() if value else None
    return {"id": note.id, "title": note.title, "content": sanitize_content(note.content),
            "color": note.color, "pinned": note.pinned, "reminder_at": iso(note.reminder_at),
            "reminder_sent": note.reminder_sent, "version": note.version,
            "created_at": iso(note.created_at), "updated_at": iso(note.updated_at)}


def _schema(db):
    from app.routers.notes_router import ensure_notes_schema
    ensure_notes_schema(db)   # sticky_notes gained record-link columns (Notes & Pinboard)


def owned_note(db, user_id, note_id):
    _schema(db)
    note = db.query(StickyNote).filter_by(id=note_id, user_id=user_id).with_for_update().first()
    if note is None:
        raise HTTPException(404, "Note not found")
    return note


@router.get("")
def list_notes(db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user)):
    _schema(db)
    return [serialize(note) for note in db.query(StickyNote).filter_by(user_id=current_user.id)
            .order_by(StickyNote.pinned.desc(), StickyNote.updated_at.desc(), StickyNote.id.desc()).all()]


@router.post("", status_code=201)
def create_note(payload: NoteInput, db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user)):
    reminder = as_ist_naive(payload.reminder_at)
    if reminder and reminder <= now_ist():
        raise HTTPException(422, "Choose a future reminder time")
    _schema(db)
    note = StickyNote(user_id=current_user.id, title=payload.title.strip() or "Untitled note",
                      content=validated_content(payload.content), color=payload.color,
                      pinned=payload.pinned, reminder_at=reminder)
    db.add(note)
    db.commit()
    db.refresh(note)
    return serialize(note)


@router.put("/{note_id}")
def update_note(note_id: int, payload: NoteUpdate, db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user)):
    note = owned_note(db, current_user.id, note_id)
    if note.version != payload.version:
        raise HTTPException(409, "This note changed in another window. Copy your changes, then reload the note.")
    reminder = as_ist_naive(payload.reminder_at)
    if reminder != note.reminder_at:
        if reminder and reminder <= now_ist():
            raise HTTPException(422, "Choose a future reminder time")
        note.reminder_sent = False
    note.title = payload.title.strip() or "Untitled note"
    note.content = validated_content(payload.content)
    note.color = payload.color
    note.pinned = payload.pinned
    note.reminder_at = reminder
    note.updated_at = now_ist()
    note.version += 1
    db.commit()
    db.refresh(note)
    return serialize(note)


@router.delete("/{note_id}", status_code=204)
def delete_note(note_id: int, db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user)):
    note = owned_note(db, current_user.id, note_id)
    db.delete(note)
    db.commit()
    return Response(status_code=204)
