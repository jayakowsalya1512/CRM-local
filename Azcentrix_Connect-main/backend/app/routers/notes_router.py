"""Notes & Pinboard (prototype v17 → Application → Notes & Pinboard).  Mounted at /api/v1/notes.

The pinboard and the footer's Quick note use the same personal notes (table sticky_notes) as the
existing note API (/api/v1/sticky-notes): every query is limited to the signed-in user's own notes in
the current tenant database.  A note can be linked to a CRM record the user is allowed to open; the
link is validated with the shared record-access helpers (module permission + Data Visibility).
"""
from __future__ import annotations

import logging
import re
import threading
from datetime import datetime
from html import unescape
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.logging import log_audit_db
from app.core.timezone import IST, now_ist
from app.dependencies import get_current_user, get_request_ip, get_tenant_db
from app.models.all_models import StickyNote, User
from app.routers.sticky_notes_router import validated_content

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Notes & Pinboard"])

# Prototype colours (A.noteC) ↔ stored colour names (shared with the header note editor).
COLOR_HEX = {"yellow": "#FFE58A", "green": "#BFE7C8", "blue": "#C9DDF7", "pink": "#F7C9D6", "lavender": "#E3D3F7"}
LEGACY_HEX = {"olive": "#FFE58A"}          # older notes: shown with the default yellow
Color = Literal["yellow", "green", "blue", "pink", "lavender"]
NEW_NOTE_TEXT = "New note…"                  # prototype addNote()
MAX_CHARS = 20000

_READY: set[str] = set()
_LOCK = threading.Lock()


def ensure_notes_schema(db: Session) -> None:
    """Add the record-link columns to sticky_notes (idempotent, once per tenant per process)."""
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        StickyNote.__table__.create(bind=bind, checkfirst=True)
        with bind.begin() as conn:
            for ddl in (
                "ALTER TABLE sticky_notes ADD COLUMN IF NOT EXISTS link_module VARCHAR(30) NULL",
                "ALTER TABLE sticky_notes ADD COLUMN IF NOT EXISTS link_record_id INT NULL",
                "ALTER TABLE sticky_notes ADD COLUMN IF NOT EXISTS link_label VARCHAR(300) NULL",
                "CREATE INDEX IF NOT EXISTS idx_sticky_notes_user_pin ON sticky_notes (user_id, pinned, updated_at)",
            ):
                conn.execute(text(ddl))
        db.commit()
        _READY.add(slug)


def ensure_notes_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant

    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant).all()]
    except Exception as exc:  # pragma: no cover - startup safety
        logger.warning("Notes schema sync: unable to list tenants: %s", exc)
        return
    finally:
        master.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_notes_schema(db)
            finally:
                db.close()
        except Exception as exc:
            logger.warning("Notes schema sync failed for %s: %s", slug, exc)


def notes_user(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    ensure_notes_schema(db)
    return cu


# ─── helpers ──────────────────────────────────────────────────────────────────

def plain(html: str) -> str:
    t = re.sub(r"<br\s*/?>|</(p|div|li)>", "\n", html or "", flags=re.I)
    return unescape(re.sub(r"<[^>]+>", "", t)).strip()


def clean(content: str, *, allow_empty: bool = False) -> str:
    cleaned = validated_content(content or "")
    txt = plain(cleaned)
    if not txt and not allow_empty:
        raise HTTPException(422, "Write something in the note first")
    if len(txt) > MAX_CHARS:
        raise HTTPException(422, f"This note is too long – keep it under {MAX_CHARS:,} characters")
    return cleaned


def title_of(content_html: str) -> str:
    first = next((ln.strip() for ln in plain(content_html).splitlines() if ln.strip()), "")
    return (first[:157] + "…") if len(first) > 160 else (first or "Untitled note")


def _link(db: Session, cu: User, module: Optional[str], record_id: Optional[int]) -> Optional[dict]:
    from app.services.calendar_service import resolve_related
    return resolve_related(db, cu, module, record_id)


def serialize(db: Session, cu: User, n: StickyNote, *, check_link: bool = True) -> dict:
    link = None
    if n.link_module and n.link_record_id:
        rec = _link(db, cu, n.link_module, n.link_record_id) if check_link else None
        # The label is kept even if access was later removed; the route only when the user can still open it.
        link = {"module": n.link_module, "id": n.link_record_id, "label": (rec or {}).get("label") or n.link_label or "",
                "route": (rec or {}).get("route"), "accessible": rec is not None}
    iso = lambda v: v.replace(tzinfo=IST).isoformat() if v else None  # noqa: E731
    return {
        "id": n.id, "content": validated_content(n.content or "") or (n.title if n.title and n.title != "Untitled note" else ""),
        "color": n.color if n.color in COLOR_HEX else "yellow", "hex": COLOR_HEX.get(n.color) or LEGACY_HEX.get(n.color, COLOR_HEX["yellow"]),
        "pinned": bool(n.pinned), "link": link, "created_at": iso(n.created_at), "updated_at": iso(n.updated_at), "version": n.version,
        "reminder_at": iso(n.reminder_at), "reminder_sent": bool(n.reminder_sent),
    }


def _own(db: Session, cu: User, note_id: int) -> StickyNote:
    n = db.query(StickyNote).filter(StickyNote.id == note_id, StickyNote.user_id == cu.id).first()
    if not n:
        raise HTTPException(404, "Note not found")
    return n


def _context(db: Session) -> Optional[str]:
    """Prototype "Personal notes in <company>" – shown when the workspace is one company of a group."""
    try:
        from app.database import MasterSessionLocal
        from app.models.tenant import Tenant
        slug = db.info.get("tenant_slug")
        if not slug:
            return None
        m = MasterSessionLocal()
        try:
            t = m.query(Tenant).filter(Tenant.slug == slug).first()
            if not t:
                return None
            in_group = bool(t.parent_group_id) or m.query(Tenant.id).filter(Tenant.parent_group_id == t.id).first() is not None
            return f"Personal notes in {t.name}" if in_group else None
        finally:
            m.close()
    except Exception as exc:  # the context line is decoration – never fail the list
        logger.info("Notes context lookup failed: %s", exc)
        return None


# ─── API ──────────────────────────────────────────────────────────────────────

class NoteIn(BaseModel):
    content: str = Field(default="", max_length=60000)
    color: Color = "yellow"
    pinned: bool = False
    source: Literal["page", "quick", "create_menu"] = "page"
    link_module: Optional[str] = None
    link_record_id: Optional[int] = None
    # "Remind me" (footer Reminders panel): a note is the lightest way to carry a
    # custom title/time reminder — reuses the existing reminder_at/reminder_sent
    # columns and sticky_note_service.deliver_due_reminders, so no new table is needed.
    reminder_at: Optional[datetime] = None


class NotePatch(BaseModel):
    content: Optional[str] = Field(default=None, max_length=60000)
    color: Optional[Color] = None
    pinned: Optional[bool] = None
    link_module: Optional[str] = None
    link_record_id: Optional[int] = None
    unlink: bool = False
    reminder_at: Optional[datetime] = None
    clear_reminder: bool = False


@router.get("")
def list_notes(db: Session = Depends(get_tenant_db), cu: User = Depends(notes_user)):
    rows = (db.query(StickyNote).filter(StickyNote.user_id == cu.id)
            .order_by(StickyNote.pinned.desc(), StickyNote.created_at.desc(), StickyNote.id.desc()).all())
    return {"items": [serialize(db, cu, n) for n in rows], "context": _context(db), "colors": COLOR_HEX}


@router.post("", status_code=201)
def create_note(body: NoteIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(notes_user)):
    if body.source == "quick":
        content = clean(body.content)                        # prototype qnSave: "Write a note first"
    else:
        content = clean(body.content, allow_empty=True) or NEW_NOTE_TEXT
    n = StickyNote(user_id=cu.id, title=title_of(content), content=content, color=body.color, pinned=body.pinned,
                    reminder_at=body.reminder_at)
    if body.link_module and body.link_record_id:
        rec = _link(db, cu, body.link_module, body.link_record_id)
        if not rec:
            raise HTTPException(422, "The linked record was not found or you can't access it")
        n.link_module, n.link_record_id, n.link_label = rec["module"], rec["id"], rec["label"][:300]
    db.add(n)
    db.flush()
    log_audit_db(db, cu.id, "notes", "create", n.id, get_request_ip(request),
                 {"quick": "Saved a quick note", "create_menu": "Created a sticky note"}.get(body.source, "Created a sticky note"),
                 new_data={"color": n.color, "pinned": n.pinned, "link": n.link_label}, record_name=n.title[:200])
    db.commit()
    db.refresh(n)
    return serialize(db, cu, n)


@router.patch("/{note_id}")
def update_note(note_id: int, body: NotePatch, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(notes_user)):
    n = _own(db, cu, note_id)
    changed = []
    if body.content is not None:
        content = clean(body.content)
        if content != n.content:
            n.content, n.title = content, title_of(content)
            changed.append("content")
    if body.color is not None and body.color != n.color:
        n.color = body.color
        changed.append("color")
    if body.pinned is not None and bool(body.pinned) != bool(n.pinned):
        n.pinned = body.pinned
        changed.append("pin" if body.pinned else "unpin")
    if body.clear_reminder and n.reminder_at:
        n.reminder_at, n.reminder_sent = None, False
        changed.append("clear_reminder")
    elif body.reminder_at is not None and body.reminder_at != n.reminder_at:
        n.reminder_at, n.reminder_sent = body.reminder_at, False
        changed.append("reminder")
    if body.unlink and n.link_module:
        n.link_module = n.link_record_id = n.link_label = None
        changed.append("unlink")
    elif body.link_module and body.link_record_id and (body.link_module, body.link_record_id) != (n.link_module, n.link_record_id):
        rec = _link(db, cu, body.link_module, body.link_record_id)
        if not rec:
            raise HTTPException(422, "The linked record was not found or you can't access it")
        n.link_module, n.link_record_id, n.link_label = rec["module"], rec["id"], rec["label"][:300]
        changed.append("link")
    if changed:
        n.updated_at = now_ist()
        n.version = (n.version or 1) + 1
        if any(c in changed for c in ("pin", "unpin", "link", "unlink")):
            log_audit_db(db, cu.id, "notes", "update", n.id, get_request_ip(request), f"Sticky note: {', '.join(changed)}", record_name=n.title[:200])
        db.commit()
        db.refresh(n)
    return serialize(db, cu, n)


@router.delete("/{note_id}")
def delete_note(note_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(notes_user)):
    n = _own(db, cu, note_id)   # only the owner's notes are visible, so nobody else can delete them
    log_audit_db(db, cu.id, "notes", "delete", n.id, get_request_ip(request), "Deleted a sticky note",
                 old_data={"content": plain(n.content)[:1000], "color": n.color, "pinned": bool(n.pinned), "link": n.link_label},
                 record_name=n.title[:200])
    db.delete(n)
    db.commit()
    return {"ok": True, "id": note_id}
