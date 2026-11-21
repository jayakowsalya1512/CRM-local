"""Calendar & Tasks service (prototype v17 → Application → Calendar & Tasks).

* Calendar events are read live from the source modules – Bids & Tenders (bid due, pre-bid), Guarantees
  (expiry), Leads (next follow-up), Travel (trip start), Tasks (due) and Orders & Projects (won tenders'
  completion date).  Each source applies that module's own view permission and Data Visibility rules,
  so the calendar never shows a record the user could not open in its module.
* Tasks live in crm_tasks.  A user sees tasks they created or are assigned to; the role's Data
  Visibility for the "calendar" module widens that to their team or everyone.
* Google Calendar sync uses OAuth 2.0 (authorisation-code flow, offline access) and the Calendar v3
  REST API.  Each CRM event is mapped to one Google event (calendar_sync_items), so a re-sync updates
  or deletes instead of duplicating.  Nothing is simulated: without a configured OAuth client the API
  says so, and the UI shows that status.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import threading
import time
from datetime import date, datetime, timedelta
from typing import Any, Iterable, Optional
from urllib.parse import urlencode, urlparse

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.timezone import now_ist, today_ist
from app.models.all_models import EMDBG, Lead, Tender, TravelRequest, User
from app.models.calendar_tasks import (
    CALENDAR_TABLES, TASK_PRIORITIES, TASK_STATUSES, CalendarConnection, CalendarSyncItem, CrmTask,
)
from app.services import inbox_service as records

logger = logging.getLogger(__name__)

# Prototype EVT – order and names are the filter-chip order on the Calendar tab.
EVENT_TYPES: list[tuple[str, str]] = [
    ("bid", "Bid due"), ("prebid", "Pre-bid"), ("bg", "Guarantee expiry"), ("lead", "Follow-up"),
    ("trip", "Travel"), ("task", "Task"), ("order", "Order due"),
]
EVENT_KEYS = [k for k, _ in EVENT_TYPES]

_SCHEMA_READY: set[str] = set()
_SCHEMA_LOCK = threading.Lock()


# ─── Schema ───────────────────────────────────────────────────────────────────

def ensure_calendar_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _SCHEMA_READY:
        return
    with _SCHEMA_LOCK:
        if slug in _SCHEMA_READY:
            return
        bind = db.get_bind()
        for table in CALENDAR_TABLES:
            table.create(bind=bind, checkfirst=True)
        from sqlalchemy import text as _text
        with bind.begin() as conn:
            conn.execute(_text("ALTER TABLE calendar_sync_items ADD COLUMN IF NOT EXISTS event_date DATE NULL"))
        db.commit()   # MariaDB: tables created after this transaction's snapshot are unreadable until it ends
        _SCHEMA_READY.add(slug)


def ensure_calendar_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant

    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant).all()]
    except Exception as exc:  # pragma: no cover - startup safety
        logger.warning("Calendar schema sync: unable to list tenants: %s", exc)
        return
    finally:
        master.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_calendar_schema(db)
            finally:
                db.close()
        except Exception as exc:
            logger.warning("Calendar schema sync failed for %s: %s", slug, exc)


# ─── Permissions / visibility ─────────────────────────────────────────────────

def can(db: Session, user: User, key: str) -> bool:
    from app.dependencies import user_has_permission
    return user_has_permission(db, user, key)


def visible_tasks(db: Session, user: User):
    """Tasks the user created or is assigned to, widened by the calendar module's Data Visibility."""
    from app.utils.data_scope import get_module_data_scope, get_team_user_ids
    q = db.query(CrmTask)
    scope = get_module_data_scope(db, user, "calendar")
    if scope == "all":
        return q
    ids = [int(user.id)] if scope in ("own", "none") else get_team_user_ids(db, int(user.id))
    return q.filter(or_(CrmTask.created_by.in_(ids), CrmTask.assignee_id.in_(ids)))


def can_edit_task(db: Session, user: User, task: CrmTask) -> bool:
    if not can(db, user, "calendar.update"):
        return False
    return visible_tasks(db, user).filter(CrmTask.id == task.id).first() is not None


def can_delete_task(db: Session, user: User, task: CrmTask) -> bool:
    if not can(db, user, "calendar.delete"):
        return False
    from app.utils.data_scope import get_module_data_scope
    # Assignees can move their tasks; only the creator (or a role with team/all visibility) removes them.
    if task.created_by == user.id:
        return True
    return get_module_data_scope(db, user, "calendar") in ("team", "all") and visible_tasks(db, user).filter(CrmTask.id == task.id).first() is not None


# ─── Related CRM records (task linking) ───────────────────────────────────────

EXTRA_LABEL = {"emdbg": "Guarantee", "travel": "Trip", "workorders": "Order"}
RELATED_ORDER = ["tenders", "opportunities", "leads", "customers", "quotations", "emdbg", "workorders", "travel"]


def _emdbg_query(db: Session, user: User):
    if not can(db, user, "emdbg.view"):
        return None
    from app.routers.emdbg_router import _apply_emdbg_scope
    return _apply_emdbg_scope(db.query(EMDBG), db, user)


def _travel_query(db: Session, user: User):
    if not can(db, user, "travel.view"):
        return None
    from app.routers.travel_router import _scope_user_ids
    q = db.query(TravelRequest)
    ids = _scope_user_ids(db, user)
    if ids is not None:
        q = q.filter(TravelRequest.employee_id.in_(ids or [-1]))
    if user.role == "accounts":
        q = q.filter(TravelRequest.status == "Approved")
    return q


def _orders_query(db: Session, user: User):
    """Orders & Projects lists won tenders (enriched with work-order data)."""
    if not can(db, user, "workorders.view"):
        return None
    from app.utils.data_scope import apply_data_scope
    q = db.query(Tender).filter(Tender.result == "Won", Tender.is_deleted == False)
    return apply_data_scope(db, q, user, "workorders", Tender.created_by, Tender.assigned_to)


def _extra_dict(module: str, row: Any) -> dict[str, Any]:
    if module == "emdbg":
        ref, title, customer, route = row.reference_num, f"{row.instrument_type} {row.reference_num}", row.client_name, "/emdbg"
    elif module == "travel":
        ref, title, customer, route = row.request_number, f"Trip: {row.to_city}", None, "/travel"
    else:
        ref = row.tender_num or f"TND-{row.id}"
        title, customer, route = row.tender_title or ref, row.customer_name, f"/workorders/{row.id}/edit"
    label = f"{EXTRA_LABEL[module]}: {ref}" + (f" – {customer}" if customer else (f" – {title}" if module == "travel" else ""))
    return {"module": module, "id": row.id, "ref": ref, "type": EXTRA_LABEL[module], "title": title, "customer": customer,
            "route": route, "label": label}


def _extra_query(db: Session, user: User, module: str):
    return {"emdbg": _emdbg_query, "travel": _travel_query, "workorders": _orders_query}[module](db, user)


def _extra_search(module: str, term: str):
    like = f"%{term}%"
    if module == "emdbg":
        return or_(EMDBG.reference_num.ilike(like), EMDBG.client_name.ilike(like), EMDBG.tender_num.ilike(like))
    if module == "travel":
        return or_(TravelRequest.request_number.ilike(like), TravelRequest.to_city.ilike(like), TravelRequest.purpose.ilike(like))
    return or_(Tender.tender_num.ilike(like), Tender.tender_title.ilike(like), Tender.customer_name.ilike(like))


def search_related(db: Session, user: User, q: str = "", per_module: int = 6) -> list[dict[str, Any]]:
    out = records.search_records(db, user, q, per_module=per_module)
    term = (q or "").strip()
    model_id = {"emdbg": EMDBG.id, "travel": TravelRequest.id, "workorders": Tender.id}
    for module in ("emdbg", "workorders", "travel"):
        try:
            query = _extra_query(db, user, module)
            if query is None:
                continue
            if term:
                query = query.filter(_extra_search(module, term))
            out += [_extra_dict(module, r) for r in query.order_by(model_id[module].desc()).limit(per_module).all()]
        except Exception as exc:
            logger.warning("Task related search failed for %s: %s", module, exc)
            db.rollback()
    return [{k: r.get(k) for k in ("module", "id", "ref", "type", "title", "customer", "route", "label")} for r in out]


def resolve_related(db: Session, user: User, module: Optional[str], record_id: Optional[int]) -> Optional[dict[str, Any]]:
    """The linked record if the user may open it (used when saving a task)."""
    if not module or not record_id:
        return None
    if module in records.RECORD_LABEL:
        r = records.resolve_record(db, user, module, record_id)
        return {k: r.get(k) for k in ("module", "id", "ref", "type", "title", "customer", "route", "label")} if r else None
    if module in EXTRA_LABEL:
        query = _extra_query(db, user, module)
        model = {"emdbg": EMDBG, "travel": TravelRequest, "workorders": Tender}[module]
        row = query.filter(model.id == int(record_id)).first() if query is not None else None
        return _extra_dict(module, row) if row else None
    return None


def related_route(module: Optional[str], record_id: Optional[int]) -> Optional[str]:
    if not module or not record_id:
        return None
    if module in records.RECORD_LABEL:
        return records.record_route(module, record_id)
    return {"emdbg": "/emdbg", "travel": "/travel", "workorders": f"/workorders/{record_id}/edit"}.get(module)


# ─── Task serialisation ───────────────────────────────────────────────────────

def user_names(db: Session, ids: Iterable[Optional[int]]) -> dict[int, str]:
    wanted = {int(i) for i in ids if i}
    if not wanted:
        return {}
    return {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(wanted)).all()}


def task_dict(t: CrmTask, names: dict[int, str], *, can_edit: bool = True, can_delete: bool = True) -> dict[str, Any]:
    return {
        "id": t.id, "title": t.title, "related": t.related_label or "", "related_module": t.related_module,
        "related_id": t.related_id, "related_route": related_route(t.related_module, t.related_id),
        "assignee_id": t.assignee_id, "assignee": names.get(t.assignee_id or 0, ""),
        "priority": t.priority, "due": t.due_date.isoformat() if t.due_date else None, "status": t.status,
        "created_by": names.get(t.created_by or 0, ""), "created_by_id": t.created_by,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        "completed_at": t.completed_at.isoformat() if t.completed_at else None,
        "source": t.source, "can_edit": can_edit, "can_delete": can_delete,
    }


# ─── Calendar events ──────────────────────────────────────────────────────────

def _ev(day: Optional[date], kind: str, title: str, module: str, record_id: int, route: Optional[str], sub: str = "") -> Optional[dict[str, Any]]:
    if not day:
        return None
    return {"key": f"{kind}:{record_id}", "date": day.isoformat(), "type": kind, "title": title, "module": module,
            "id": record_id, "route": route, "sub": sub}


def collect_events(db: Session, user: User, start: date, end: date, types: Optional[Iterable[str]] = None) -> list[dict[str, Any]]:
    """All calendar events between start and end (inclusive) the user may see, for the selected types."""
    want = set(types or EVENT_KEYS) & set(EVENT_KEYS)
    out: list[dict[str, Any]] = []

    def run(kind: str, fn) -> None:
        try:
            out.extend(e for e in fn() if e)
        except Exception as exc:  # one failing source must not blank the calendar
            logger.warning("Calendar source %s failed: %s", kind, exc)
            db.rollback()

    if want & {"bid", "prebid"}:
        def tenders():
            q = records._record_query(db, user, "tenders")
            if q is None:
                return []
            live = q.filter(Tender.tender_status != "Closed", or_(Tender.result.is_(None), Tender.result == "Pending"))
            res = []
            if "bid" in want:
                for t in live.filter(Tender.submission_date.between(start, end)).all():
                    ref = t.tender_num or f"TND-{t.id}"
                    res.append(_ev(t.submission_date, "bid", ref, "tenders", t.id, records.record_route("tenders", t.id), t.customer_name or t.tender_title or ""))
            if "prebid" in want:
                for t in live.filter(Tender.pre_bid_date.between(start, end)).all():
                    ref = t.tender_num or f"TND-{t.id}"
                    res.append(_ev(t.pre_bid_date, "prebid", f"Pre-bid {ref}", "tenders", t.id, records.record_route("tenders", t.id), t.customer_name or ""))
            return res
        run("tenders", tenders)

    if "bg" in want:
        def guarantees():
            q = _emdbg_query(db, user)
            if q is None:
                return []
            rows = q.filter(EMDBG.status == "Active", EMDBG.expiry_date.between(start, end)).all()
            return [_ev(e.expiry_date, "bg", f"{e.instrument_type} {e.reference_num}", "emdbg", e.id, "/emdbg", e.client_name or "") for e in rows]
        run("emdbg", guarantees)

    if "lead" in want:
        def followups():
            res = []
            for module in ("leads", "opportunities"):
                q = records._record_query(db, user, module)
                if q is None:
                    continue
                rows = q.filter(Lead.follow_up.between(start, end), Lead.status.notin_(("Converted", "Lost"))).all()
                res += [_ev(l.follow_up, "lead", f"Call {l.customer_name or l.lead_title}", module, l.id, records.record_route(module, l.id), l.lead_title or "") for l in rows]
            return res
        run("leads", followups)

    if "trip" in want:
        def trips():
            q = _travel_query(db, user)
            if q is None:
                return []
            rows = q.filter(TravelRequest.travel_date.between(start, end), TravelRequest.status.notin_(("Cancelled", "Rejected"))).all()
            return [_ev(t.travel_date, "trip", f"Trip: {t.to_city}", "travel", t.id, "/travel", t.request_number) for t in rows]
        run("travel", trips)

    if "task" in want and can(db, user, "calendar.view"):
        def tasks():
            rows = visible_tasks(db, user).filter(CrmTask.status != "Done", CrmTask.due_date.between(start, end)).all()
            return [_ev(t.due_date, "task", t.title, "calendar", t.id, None, t.related_label or "") for t in rows]
        run("tasks", tasks)

    if "order" in want:
        def orders():
            q = _orders_query(db, user)
            if q is None:
                return []
            rows = q.filter(Tender.completion_date.between(start, end)).all()
            return [_ev(t.completion_date, "order", f"Due: {t.tender_title or t.tender_num or t.id}", "workorders", t.id, f"/workorders/{t.id}/edit", t.customer_name or "") for t in rows]
        run("orders", orders)

    out.sort(key=lambda e: (e["date"], EVENT_KEYS.index(e["type"]), e["title"]))
    return out


# ─── Google Calendar sync ─────────────────────────────────────────────────────

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
GOOGLE_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/{cal}/events"
GOOGLE_SCOPES = "openid email https://www.googleapis.com/auth/calendar.events"
SYNC_PAST_DAYS = 30
SYNC_FUTURE_DAYS = 180
HTTP_TIMEOUT = 20


class SyncError(Exception):
    def __init__(self, message: str, status: str = "failed", http_status: int = 502):
        super().__init__(message)
        self.status = status
        self.http_status = http_status


def google_configured() -> bool:
    return bool(settings.GOOGLE_CALENDAR_CLIENT_ID and settings.GOOGLE_CALENDAR_CLIENT_SECRET)


def redirect_uri() -> str:
    return settings.GOOGLE_CALENDAR_REDIRECT_URI or f"{settings.FRONTEND_BASE_URL.rstrip('/')}/api/v1/calendar/sync/google/callback"


def _key() -> bytes:
    return hashlib.sha256(("calendar-sync:" + settings.SECRET_KEY).encode()).digest()


def encrypt_tokens(tokens: dict) -> str:
    nonce = os.urandom(12)
    return base64.b64encode(nonce + AESGCM(_key()).encrypt(nonce, json.dumps(tokens).encode(), b"calendar")).decode()


def decrypt_tokens(blob: Optional[str]) -> dict:
    if not blob:
        return {}
    raw = base64.b64decode(blob)
    return json.loads(AESGCM(_key()).decrypt(raw[:12], raw[12:], b"calendar"))


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def allowed_return_origin(origin: Optional[str]) -> str:
    """The SPA origin to send the user back to after Google consent (never an arbitrary site)."""
    base = urlparse(settings.FRONTEND_BASE_URL)
    fallback = f"{base.scheme}://{base.netloc}"
    if not origin:
        return fallback
    p = urlparse(origin)
    candidate = f"{p.scheme}://{p.netloc}"
    allowed = {fallback} | {o.rstrip("/") for o in (settings.ALLOWED_ORIGINS or [])}
    return candidate if p.scheme in ("http", "https") and candidate in allowed else fallback


def make_state(tenant_slug: str, user_id: int, return_origin: str) -> str:
    payload = _b64(json.dumps({"t": tenant_slug, "u": int(user_id), "o": return_origin, "x": int(time.time()) + 900,
                               "n": _b64(os.urandom(9))}).encode())
    sig = _b64(hmac.new(_key(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}"


def read_state(state: str) -> dict:
    try:
        payload, sig = state.split(".", 1)
        good = _b64(hmac.new(_key(), payload.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(good, sig):
            raise ValueError("bad signature")
        data = json.loads(_unb64(payload))
        if int(data["x"]) < time.time():
            raise ValueError("expired")
        return data
    except Exception as exc:
        raise SyncError("The Google sign-in link is invalid or has expired. Start again from Sync calendar.", "auth_failed", 400) from exc


def auth_url(state: str) -> str:
    return GOOGLE_AUTH_URL + "?" + urlencode({
        "client_id": settings.GOOGLE_CALENDAR_CLIENT_ID, "redirect_uri": redirect_uri(), "response_type": "code",
        "scope": GOOGLE_SCOPES, "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true", "state": state,
    })


def _google_error(resp: requests.Response) -> str:
    try:
        body = resp.json()
        err = body.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err.get("status") or resp.status_code)
        return str(body.get("error_description") or err or resp.status_code)
    except Exception:
        return f"HTTP {resp.status_code}"


def exchange_code(code: str) -> dict:
    try:
        resp = requests.post(GOOGLE_TOKEN_URL, data={
            "code": code, "client_id": settings.GOOGLE_CALENDAR_CLIENT_ID, "client_secret": settings.GOOGLE_CALENDAR_CLIENT_SECRET,
            "redirect_uri": redirect_uri(), "grant_type": "authorization_code",
        }, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise SyncError(f"Could not reach Google: {exc.__class__.__name__}") from exc
    if resp.status_code != 200:
        raise SyncError(f"Google refused the authorisation: {_google_error(resp)}", "auth_failed", 400)
    tok = resp.json()
    tokens = {"access_token": tok.get("access_token"), "refresh_token": tok.get("refresh_token"),
              "expires_at": int(time.time()) + int(tok.get("expires_in") or 3600) - 60}
    email = None
    try:
        info = requests.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {tokens['access_token']}"}, timeout=HTTP_TIMEOUT)
        if info.status_code == 200:
            email = info.json().get("email")
    except requests.RequestException:
        pass
    tokens["email"] = email
    return tokens


def save_connection(db: Session, user_id: int, tokens: dict) -> CalendarConnection:
    conn = db.query(CalendarConnection).filter_by(user_id=user_id, provider="google").first()
    old = decrypt_tokens(conn.token_blob) if conn and conn.token_blob else {}
    if not tokens.get("refresh_token") and old.get("refresh_token"):
        tokens["refresh_token"] = old["refresh_token"]          # Google omits it on re-consent
    if not conn:
        conn = CalendarConnection(user_id=user_id, provider="google", calendar_id="primary")
        db.add(conn)
    conn.account_email = tokens.pop("email", None) or conn.account_email
    conn.token_blob = encrypt_tokens(tokens)
    conn.status = "connected"
    conn.last_message = None
    db.flush()
    return conn


def _access_token(db: Session, conn: CalendarConnection, force_refresh: bool = False) -> str:
    tokens = decrypt_tokens(conn.token_blob)
    if not force_refresh and tokens.get("access_token") and int(tokens.get("expires_at") or 0) > time.time():
        return tokens["access_token"]
    if not tokens.get("refresh_token"):
        raise SyncError("Google Calendar access has expired. Reconnect your Google account.", "auth_failed", 401)
    try:
        resp = requests.post(GOOGLE_TOKEN_URL, data={
            "client_id": settings.GOOGLE_CALENDAR_CLIENT_ID, "client_secret": settings.GOOGLE_CALENDAR_CLIENT_SECRET,
            "refresh_token": tokens["refresh_token"], "grant_type": "refresh_token",
        }, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise SyncError(f"Could not reach Google: {exc.__class__.__name__}") from exc
    if resp.status_code in (400, 401):
        raise SyncError(f"Google Calendar access was revoked or expired ({_google_error(resp)}). Reconnect your Google account.", "auth_failed", 401)
    if resp.status_code != 200:
        raise SyncError(f"Google token refresh failed: {_google_error(resp)}")
    tok = resp.json()
    tokens["access_token"] = tok["access_token"]
    tokens["expires_at"] = int(time.time()) + int(tok.get("expires_in") or 3600) - 60
    conn.token_blob = encrypt_tokens(tokens)
    return tokens["access_token"]


class _Google:
    """Tiny Calendar v3 client: one retry with a refreshed token on 401."""

    def __init__(self, db: Session, conn: CalendarConnection):
        self.db, self.conn = db, conn
        self.token = _access_token(db, conn)
        self.base = GOOGLE_EVENTS_URL.format(cal=requests.utils.quote(conn.calendar_id or "primary", safe=""))

    def call(self, method: str, path: str = "", **kw) -> requests.Response:
        for attempt in (0, 1):
            try:
                resp = requests.request(method, self.base + path, headers={"Authorization": f"Bearer {self.token}"}, timeout=HTTP_TIMEOUT, **kw)
            except requests.RequestException as exc:
                raise SyncError(f"Could not reach Google Calendar: {exc.__class__.__name__}") from exc
            if resp.status_code == 401 and attempt == 0:
                self.token = _access_token(self.db, self.conn, force_refresh=True)
                continue
            if resp.status_code == 401:
                raise SyncError("Google Calendar rejected the saved authorisation. Reconnect your Google account.", "auth_failed", 401)
            if resp.status_code == 403 and "insufficient" in _google_error(resp).lower():
                raise SyncError("Calendar permission was not granted. Reconnect and allow calendar access.", "auth_failed", 401)
            return resp
        raise SyncError("Google Calendar request failed")


def _fingerprint(ev: dict) -> str:
    return hashlib.sha256(json.dumps([ev["date"], ev["title"], ev["sub"], ev["route"]], sort_keys=True).encode()).hexdigest()


def _google_body(ev: dict, label: str) -> dict:
    day = date.fromisoformat(ev["date"])
    link = f"{settings.FRONTEND_BASE_URL.rstrip('/')}{ev['route'] or '/calendar'}"
    desc = "\n".join(x for x in (ev["sub"], f"{label} · Azcentrix Connect", link) if x)
    return {
        "summary": f"{label}: {ev['title']}" if not ev["title"].startswith(label) else ev["title"],
        "description": desc, "start": {"date": day.isoformat()}, "end": {"date": (day + timedelta(days=1)).isoformat()},
        "transparency": "transparent", "source": {"title": "Azcentrix Connect", "url": link},
        "extendedProperties": {"private": {"azcentrixKey": ev["key"]}},
    }


def sync_window() -> tuple[date, date]:
    today = today_ist()
    return today - timedelta(days=SYNC_PAST_DAYS), today + timedelta(days=SYNC_FUTURE_DAYS)


def run_google_sync(db: Session, user: User, conn: CalendarConnection) -> dict[str, Any]:
    """Push the user's visible CRM events in the sync window to Google Calendar; idempotent."""
    start, end = sync_window()
    events = collect_events(db, user, start, end)
    labels = dict(EVENT_TYPES)
    counts = {"created": 0, "updated": 0, "deleted": 0, "unchanged": 0, "failed": 0}
    errors: list[str] = []
    try:
        g = _Google(db, conn)
        items = {i.event_key: i for i in db.query(CalendarSyncItem).filter_by(connection_id=conn.id).all()}
        seen: set[str] = set()
        for ev in events:
            key = ev["key"]
            if key in seen:
                continue
            seen.add(key)
            fp = _fingerprint(ev)
            item = items.get(key)
            if item and item.fingerprint == fp:
                counts["unchanged"] += 1
                continue
            body = _google_body(ev, labels[ev["type"]])
            try:
                resp = None
                if item:
                    resp = g.call("PATCH", f"/{requests.utils.quote(item.external_id, safe='')}", json=body)
                    if resp.status_code in (404, 410):
                        resp = None                      # deleted in Google – recreate below
                if resp is None and not item:
                    # Mapping lost (e.g. reconnect): adopt an existing copy instead of inserting a duplicate.
                    found = g.call("GET", params={"privateExtendedProperty": f"azcentrixKey={key}", "maxResults": 1, "showDeleted": "false"})
                    hit = (found.json().get("items") or [None])[0] if found.status_code == 200 else None
                    if hit:
                        resp = g.call("PATCH", f"/{requests.utils.quote(hit['id'], safe='')}", json=body)
                if resp is None:
                    resp = g.call("POST", json=body)
                    created = True
                else:
                    created = False
                if resp.status_code not in (200, 201):
                    counts["failed"] += 1
                    errors.append(f"{ev['title']}: {_google_error(resp)}")
                    continue
                gid = resp.json()["id"]
                if item:
                    item.external_id, item.fingerprint, item.event_date = gid, fp, date.fromisoformat(ev["date"])
                else:
                    db.add(CalendarSyncItem(connection_id=conn.id, event_key=key, external_id=gid, fingerprint=fp, event_date=date.fromisoformat(ev["date"])))
                counts["created" if created and not item else "updated"] += 1
            except SyncError:
                raise
            except Exception as exc:
                counts["failed"] += 1
                errors.append(f"{ev['title']}: {exc}")
        # Events that disappeared (task done/deleted, bid closed, date moved out) – only inside the window,
        # so older history already in Google is left alone.
        for key, item in items.items():
            if key in seen or (item.event_date and (item.event_date < start or item.event_date > end)):
                continue
            resp = g.call("DELETE", f"/{requests.utils.quote(item.external_id, safe='')}")
            if resp.status_code in (200, 204, 404, 410):
                db.delete(item)
                counts["deleted"] += 1
            else:
                counts["failed"] += 1
                errors.append(f"Remove {key}: {_google_error(resp)}")
    except SyncError as exc:
        conn.last_sync_at = now_ist()
        conn.last_status = exc.status
        conn.last_message = str(exc)[:500]
        if exc.status == "auth_failed":
            conn.status = "auth_failed"
        db.commit()
        raise
    conn.status = "connected"
    conn.last_sync_at = now_ist()
    conn.last_status = "partial" if counts["failed"] else "ok"
    conn.last_counts = ",".join(f"{k}:{v}" for k, v in counts.items())
    conn.last_message = ("; ".join(errors))[:500] if errors else None
    db.commit()
    return {"counts": counts, "errors": errors[:5], "events": len(seen)}


def revoke(conn: CalendarConnection) -> None:
    try:
        tokens = decrypt_tokens(conn.token_blob)
        token = tokens.get("refresh_token") or tokens.get("access_token")
        if token:
            requests.post(GOOGLE_REVOKE_URL, data={"token": token}, timeout=HTTP_TIMEOUT)
    except Exception as exc:  # revoking is best effort – the local tokens are deleted regardless
        logger.info("Google token revoke failed: %s", exc)


def sync_status(db: Session, user: User) -> dict[str, Any]:
    conn = db.query(CalendarConnection).filter_by(user_id=user.id, provider="google").first()
    counts = {}
    if conn and conn.last_counts:
        for part in conn.last_counts.split(","):
            k, _, v = part.partition(":")
            if v.isdigit():
                counts[k] = int(v)
    return {
        "provider": "google", "configured": google_configured(), "connected": bool(conn and conn.token_blob),
        "status": (conn.status if conn else "not_connected") if google_configured() else "not_configured",
        "account": conn.account_email if conn else None,
        "last_sync_at": conn.last_sync_at.isoformat() if conn and conn.last_sync_at else None,
        "last_status": conn.last_status if conn else None, "last_message": conn.last_message if conn else None,
        "counts": counts, "window_days": [SYNC_PAST_DAYS, SYNC_FUTURE_DAYS],
    }


__all__ = [
    "EVENT_TYPES", "TASK_STATUSES", "TASK_PRIORITIES", "SyncError", "collect_events", "ensure_calendar_schema",
    "ensure_calendar_schema_all_tenants", "search_related", "resolve_related", "task_dict", "visible_tasks",
]
