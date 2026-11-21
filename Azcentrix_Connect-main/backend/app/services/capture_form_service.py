"""Lead capture forms (prototype v17 · Sales → Capture Forms) – configuration, routing, spam protection, submission
pipeline and KPIs.

Masters used (never copied):
* Lead sources  – lead_sources (form "Lead source")
* Products      – products_master ("Interested in" options on the public form, product line on the lead)
* States        – states ("State" options; drives "By state" routing)
* Teams / users – org_tree_nodes level-2 group nodes and their active descendants ("Round-robin: <team>"),
                  users.state_id ("By state"), active users ("<name> (manual review)")

Every valid submission goes through lead_router.create_lead (lead reference, follow-up rules, notifications,
workflow events, audit, outgoing webhooks). Duplicates (an open lead for the same customer / e-mail / company)
are attached to the existing lead instead of creating a new one.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import threading
import time
from collections import defaultdict
from datetime import timedelta
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.logging import log_audit_db
from app.core.timezone import now_ist
from app.core.validators import check_email, check_mobile
from app.models.all_models import Customer, CustomerContact, Lead, LeadSource, OrgTreeNode, ProductMaster, State, User
from app.models.capture_forms import CAPTURE_TABLES, CaptureForm, CaptureSubmission
from app.models.lead360 import LeadContactLink, LeadNote

logger = logging.getLogger(__name__)

# Prototype CAPFL – the nine fields, in this order.
FIELDS: list[tuple[str, str, str]] = [
    ("name", "Company name", "text"),
    ("contact", "Contact person", "text"),
    ("email", "Work email", "email"),
    ("phone", "Phone", "tel"),
    ("interest", "Interested in", "product"),
    ("value", "Budget (₹)", "number"),
    ("message", "Message", "textarea"),
    ("tender", "Tender / NIT number", "text"),
    ("state", "State", "state"),
]
FIELD_KEYS = [k for k, _, _ in FIELDS]
LABEL = {k: l for k, l, _ in FIELDS}
KIND = {k: t for k, _, t in FIELDS}
SPAM_MODES = ["Honeypot", "CAPTCHA", "Honeypot + CAPTCHA"]
DEFAULT_FIELDS = ["name", "contact", "email", "phone", "interest"]   # prototype capNew()
DEFAULT_REQUIRED = ["name", "email"]
OPEN_STAGES = ("Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing")
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
PHONE_RE = re.compile(r"^[0-9+()\-\s]{6,20}$")
MIN_FILL_SECONDS = 3            # time trap: humans need longer than this to fill a form
RENDER_TTL = 6 * 3600           # a rendered form stays valid for 6 h
CAPTCHA_TTL = 30 * 60
RATE_FORM_IP = (5, 10)          # at most 5 submissions per form per IP per 10 minutes (more = spam)
RATE_TENANT_IP = (20, 10)       # hard limit per IP across the tenant – refused with 429, not stored

_READY: set[str] = set()
_LOCK = threading.Lock()


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        from app.models.lead360 import LEAD360_TABLES
        bind = db.get_bind()
        for t in LEAD360_TABLES + CAPTURE_TABLES:      # lead_notes is used for duplicate submissions
            t.create(bind=bind, checkfirst=True)
        db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    m = MasterSessionLocal()
    try:
        slugs = [t.slug for t in m.query(Tenant).all()]
    finally:
        m.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
        except Exception as exc:
            logger.warning("capture forms schema: tenant %s unavailable: %s", slug, exc)
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
        except Exception as exc:
            logger.warning("capture forms schema for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()


# ─── masters ──────────────────────────────────────────────────────────────────

def _ids(v: Any) -> set[int]:
    out = set()
    for p in str(v or "").replace(";", ",").split(","):
        p = p.strip()
        if p.isdigit():
            out.add(int(p))
    return out


def active_users(db: Session) -> dict[int, User]:
    return {u.id: u for u in db.query(User).filter(User.is_active == True).all()}


def teams(db: Session) -> list[dict[str, Any]]:
    """Teams = level-2 group nodes of the organisation tree (Users & Teams); members = the group lead and every
    active node below the group."""
    nodes = db.query(OrgTreeNode).filter(OrgTreeNode.is_active == True).all()
    kids: dict[int, list[OrgTreeNode]] = defaultdict(list)
    for n in nodes:
        if n.parent_id:
            kids[n.parent_id].append(n)
    users = active_users(db)
    out = []
    for g in sorted((n for n in nodes if n.level == 2), key=lambda n: (n.position or 0, n.id)):
        members, stack = [], [g]
        while stack:
            n = stack.pop()
            members.append(n.user_id)
            stack.extend(kids.get(n.id, []))
        if g.group_lead_id:
            members.append(g.group_lead_id)
        ids = sorted({u for u in members if u in users})
        name = (g.group_name or "").strip() or (users[g.user_id].full_name if g.user_id in users else f"Team {g.id}")
        out.append({"id": g.id, "name": name, "members": ids})
    return out


def routing_options(db: Session, current: Optional[str] = None) -> list[dict[str, Any]]:
    users = active_users(db)
    groups = [{"group": "Teams (round-robin)", "items": [
        {"value": f"team:{t['id']}", "label": f"Round-robin: {t['name']}", "sub": f"{len(t['members'])} member{'s' if len(t['members']) != 1 else ''}",
         "disabled": not t["members"]} for t in teams(db)]}]
    covered = sum(1 for u in users.values() if _ids(u.state_id))
    groups.append({"group": "By state", "items": [
        {"value": "state", "label": "By state: users covering the submitted state", "sub": f"{covered} users have states", "disabled": not covered}]})
    groups.append({"group": "Specific user", "items": [
        {"value": f"user:{u.id}", "label": f"{u.full_name} (manual review)", "sub": (u.role or "").replace("_", " ")}
        for u in sorted(users.values(), key=lambda x: (x.full_name or "").lower())]})
    known = {i["value"] for g in groups for i in g["items"]}
    if current and current not in known:   # keep history: a removed team / deactivated user still shows
        groups.append({"group": "No longer available", "items": [{"value": current, "label": describe_mode(db, current), "disabled": True}]})
    return [g for g in groups if g["items"]]


def describe_mode(db: Session, mode: str) -> str:
    kind, _, ref = (mode or "").partition(":")
    if kind == "team":
        node = db.query(OrgTreeNode).filter(OrgTreeNode.id == int(ref or 0)).first()
        return f"Round-robin: {(node.group_name if node else None) or 'removed team'}"
    if kind == "state":
        return "By state: users covering the submitted state"
    if kind == "user":
        u = db.query(User).filter(User.id == int(ref or 0)).first()
        return f"{u.full_name if u else 'Removed user'} (manual review)"
    return mode or "—"


def valid_mode(db: Session, mode: str) -> bool:
    kind, _, ref = (mode or "").partition(":")
    if kind == "state":
        return True
    if not ref.isdigit():
        return False
    if kind == "team":
        return any(t["id"] == int(ref) for t in teams(db))
    if kind == "user":
        return db.query(User.id).filter(User.id == int(ref), User.is_active == True).first() is not None
    return False


def sources(db: Session, keep: Optional[int] = None) -> list[dict[str, Any]]:
    rows = db.query(LeadSource).filter((LeadSource.is_active == True) | (LeadSource.id == (keep or -1))).order_by(LeadSource.name).all()
    return [{"id": s.id, "name": s.name + ("" if s.is_active else " (inactive)"), "active": bool(s.is_active)} for s in rows]


def products(db: Session) -> list[dict[str, Any]]:
    return [{"id": p.id, "name": p.name} for p in db.query(ProductMaster).filter(ProductMaster.is_active == True).order_by(ProductMaster.name).all()]


def states(db: Session) -> list[dict[str, Any]]:
    return [{"id": s.id, "name": s.name} for s in db.query(State).filter(State.is_active == True).order_by(State.name).all()]


def default_source_id(db: Session) -> Optional[int]:
    row = db.query(LeadSource).filter(LeadSource.is_active == True, func.lower(LeadSource.name) == "website").first() \
        or db.query(LeadSource).filter(LeadSource.is_active == True).order_by(LeadSource.id).first()
    return row.id if row else None


def default_mode(db: Session, user: User) -> str:
    for t in teams(db):
        if t["members"]:
            return f"team:{t['id']}"
    return f"user:{user.id}"


# ─── serialisation ────────────────────────────────────────────────────────────

def clean_fields(fields: list[str]) -> list[str]:
    chosen = {f for f in fields or [] if f in FIELD_KEYS}
    return [k for k in FIELD_KEYS if k in chosen]          # always in the prototype order


def form_dict(db: Session, f: CaptureForm, stats: Optional[dict] = None) -> dict[str, Any]:
    src = db.query(LeadSource).filter(LeadSource.id == f.source_id).first() if f.source_id else None
    s = (stats or {}).get(f.id, {})
    return {
        "id": f.id, "key": f.public_key, "name": f.name, "on": bool(f.is_published), "fields": clean_fields(f.fields or []),
        "required": [r for r in clean_fields(f.required or []) if r in (f.fields or [])], "assign": f.assign_mode,
        "assign_label": describe_mode(db, f.assign_mode), "source_id": f.source_id, "source": src.name if src else None,
        "thanks": f.thanks or "", "spam": f.spam, "subs": s.get("subs", 0), "leads": s.get("leads", 0), "conv": s.get("conv", 0),
        "updated_at": f.updated_at.isoformat() if f.updated_at else None,
    }


def new_key(db: Session) -> str:
    while True:
        k = secrets.token_urlsafe(9).replace("-", "x").replace("_", "y")[:12].lower()
        if not db.query(CaptureForm.id).filter(CaptureForm.public_key == k).first():
            return k


# ─── signed tokens (render time + self-hosted arithmetic CAPTCHA) ─────────────

def _secret() -> bytes:
    return hashlib.sha256(("capture-forms:" + (settings.SECRET_KEY or "")).encode()).digest()


def _sign(payload: dict) -> str:
    raw = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(hmac.new(_secret(), raw.encode(), hashlib.sha256).digest()[:18]).decode().rstrip("=")
    return f"{raw}.{sig}"


def _unsign(token: str) -> Optional[dict]:
    try:
        raw, sig = (token or "").split(".", 1)
        good = base64.urlsafe_b64encode(hmac.new(_secret(), raw.encode(), hashlib.sha256).digest()[:18]).decode().rstrip("=")
        if not hmac.compare_digest(good, sig):
            return None
        return json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    except Exception:
        return None


def render_token(slug: str, key: str) -> str:
    return _sign({"k": key, "s": slug, "i": int(time.time())})


def captcha(slug: str, key: str) -> dict[str, str]:
    a, b = 2 + secrets.randbelow(8), 2 + secrets.randbelow(8)
    nonce = secrets.token_hex(6)
    h = hashlib.sha256(f"{a + b}:{nonce}".encode()).hexdigest()[:20]
    return {"question": f"What is {a} + {b}?", "token": _sign({"k": key, "s": slug, "n": nonce, "h": h, "e": int(time.time()) + CAPTCHA_TTL})}


def _captcha_ok(slug: str, key: str, token: str, answer: str) -> bool:
    p = _unsign(token)
    if not p or p.get("k") != key or p.get("s") != slug or int(p.get("e") or 0) < time.time():
        return False
    ans = str(answer or "").strip()
    return ans.isdigit() and hmac.compare_digest(hashlib.sha256(f"{int(ans)}:{p.get('n')}".encode()).hexdigest()[:20], str(p.get("h")))


# ─── validation ───────────────────────────────────────────────────────────────

def validate(db: Session, form: CaptureForm, raw: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    fields, req = clean_fields(form.fields or []), set(form.required or [])
    vals: dict[str, Any] = {}
    errs: dict[str, str] = {}
    for k in fields:
        v = raw.get(k)
        v = "" if v is None else str(v).strip()
        if not v:
            if k in req:
                errs[k] = f"{LABEL[k]} is required"
            continue
        kind = KIND[k]
        if kind == "email":
            try:
                v = check_email(v) or v
            except ValueError as e:
                errs[k] = str(e)
        elif kind == "tel":
            try:
                v = check_mobile(v, LABEL[k]) or v
            except ValueError as e:
                errs[k] = str(e)
        elif kind == "number":
            try:
                n = float(v.replace(",", ""))
                if n < 0 or n > 1e13:
                    raise ValueError
                v = n
            except ValueError:
                errs[k] = "Enter an amount in ₹"
        elif kind == "product":
            p = db.query(ProductMaster).filter(ProductMaster.id == int(v), ProductMaster.is_active == True).first() if v.isdigit() else None
            if not p:
                errs[k] = "Choose one of the listed products / services"
            else:
                v = {"id": p.id, "name": p.name}
        elif kind == "state":
            s = db.query(State).filter(State.id == int(v), State.is_active == True).first() if v.isdigit() else None
            if not s:
                errs[k] = "Choose a state from the list"
            else:
                v = {"id": s.id, "name": s.name}
        else:
            limit = 5000 if kind == "textarea" else (200 if k in ("contact", "tender") else 300)
            if len(v) > limit:
                errs[k] = f"{LABEL[k]} is too long"
        if k not in errs:
            vals[k] = v
    if not any(vals.get(k) for k in ("name", "contact", "email", "phone")) and not errs:
        errs["name"] = "Tell us who you are – company, contact, e-mail or phone"
    return vals, errs


# ─── routing ──────────────────────────────────────────────────────────────────

def _rr(form: CaptureForm, ids: list[int]) -> int:
    cur = int(form.rr_cursor or 0)
    form.rr_cursor = cur + 1
    return ids[cur % len(ids)]


def route(db: Session, form: CaptureForm, vals: dict[str, Any]) -> tuple[Optional[int], dict[str, Any]]:
    users = active_users(db)
    mode = form.assign_mode or ""
    kind, _, ref = mode.partition(":")
    notes: list[str] = []
    who: Optional[int] = None
    if kind == "team":
        t = next((x for x in teams(db) if x["id"] == int(ref or 0)), None)
        if t and t["members"]:
            who = _rr(form, t["members"])
            notes.append(f"Round-robin in {t['name']} ({len(t['members'])} members)")
        else:
            notes.append("Team not found or has no active members")
    elif kind == "state":
        st = vals.get("state")
        if not st:
            notes.append("No state submitted – state routing needs the State field")
        else:
            ids = sorted(u.id for u in users.values() if st["id"] in _ids(u.state_id))
            if ids:
                who = _rr(form, ids)
                notes.append(f"{st['name']}: round-robin among {len(ids)} user{'s' if len(ids) != 1 else ''}")
            else:
                notes.append(f"No active user covers {st['name']}")
    elif kind == "user":
        if int(ref or 0) in users:
            who = int(ref)
            notes.append("Assigned for manual review")
        else:
            notes.append("Configured user is inactive or removed")
    if who is None and form.created_by in users:
        who = form.created_by
        notes.append(f"Fallback: form owner {users[who].full_name}")
    return who, {"mode": mode, "rule": describe_mode(db, mode), "assigned": who, "assigned_name": users[who].full_name if who in users else None, "notes": notes}


# ─── duplicates (existing rule: an open lead for the same customer – plus e-mail / company for web leads) ──

def find_customer(db: Session, name: Optional[str]) -> Optional[Customer]:
    if not name:
        return None
    q = db.query(Customer).filter(func.lower(Customer.customer_name) == name.strip().lower())
    for col, val in (("is_deleted", False), ("is_active", True)):
        if hasattr(Customer, col):
            q = q.filter(getattr(Customer, col) == val)
    return next((c for c in q.order_by(Customer.id).all() if (getattr(c, "approval_status", "") or "").lower() != "rejected"), None)


def find_contact(db: Session, customer_id: int, email: Optional[str], phone: Optional[str]) -> Optional[CustomerContact]:
    q = db.query(CustomerContact).filter(CustomerContact.customer_id == customer_id, CustomerContact.is_active == True)
    if email:
        c = q.filter(func.lower(CustomerContact.office_email) == email.lower()).first()
        if c:
            return c
    if phone:
        digits = re.sub(r"\D", "", phone)[-10:]
        for c in q.all():
            if digits and any(re.sub(r"\D", "", x or "")[-10:] == digits for x in (c.mobile, getattr(c, "office_phone", None))):
                return c
    return None


def find_duplicate(db: Session, customer: Optional[Customer], vals: dict[str, Any]) -> Optional[Lead]:
    q = db.query(Lead).filter(Lead.is_deleted == False, Lead.status.in_(OPEN_STAGES), Lead.lead_type != "direct_opportunity")
    if customer:
        rows = q.filter(Lead.customer_id == customer.id).order_by(Lead.id.desc()).all()
        prod = (vals.get("interest") or {}).get("id")
        if rows and prod:
            from app.services.lead360_service import first_products
            fp = first_products(db, [r.id for r in rows])
            same = [r for r in rows if fp.get(r.id, {}).get("product_id") == prod]
            return same[0] if same else rows[0]
        return rows[0] if rows else None
    if vals.get("email"):
        r = q.filter(func.lower(Lead.email) == str(vals["email"]).lower()).order_by(Lead.id.desc()).first()
        if r:
            return r
    if vals.get("name"):
        return q.filter(Lead.customer_id.is_(None), func.lower(Lead.customer_name) == str(vals["name"]).lower()).order_by(Lead.id.desc()).first()
    return None


# ─── pipeline ─────────────────────────────────────────────────────────────────

def client_ip(request: Request) -> str:
    """Visitor address for rate limiting. X-Forwarded-For is only trusted when the direct peer is our own reverse proxy
    (private / loopback address), and then only its last hop – the one that proxy appended – so a visitor cannot dodge
    the limit by sending a forged header."""
    import ipaddress
    peer = (request.client.host if request.client else "") or ""
    hops = [h.strip() for h in (request.headers.get("x-forwarded-for") or "").split(",") if h.strip()]
    try:
        trusted = ipaddress.ip_address(peer).is_private or ipaddress.ip_address(peer).is_loopback
    except ValueError:
        trusted = False
    return ((hops[-1] if hops and trusted else peer) or "unknown")[:64]


def _rate(db: Session, ip: str, form_id: Optional[int], minutes: int) -> int:
    q = db.query(func.count(CaptureSubmission.id)).filter(CaptureSubmission.ip == ip, CaptureSubmission.is_test == False,
                                                          CaptureSubmission.received_at >= now_ist() - timedelta(minutes=minutes))
    if form_id:
        q = q.filter(CaptureSubmission.form_id == form_id)
    return int(q.scalar() or 0)


def _next_ref(db: Session) -> str:
    prefix = now_ist().strftime("CF%y%m")
    last = db.query(CaptureSubmission.ref).filter(CaptureSubmission.ref.like(f"{prefix}%")).order_by(CaptureSubmission.ref.desc()).first()
    n = int(last[0][len(prefix):]) + 1 if last and last[0][len(prefix):].isdigit() else 1
    return f"{prefix}{n:05d}"


def submit(db: Session, slug: str, form: CaptureForm, body: dict[str, Any], request: Request, *, test_user: Optional[User] = None) -> dict[str, Any]:
    """Validate → spam checks → duplicate check → routing → lead via lead_router.create_lead. Returns the API reply."""
    is_test = test_user is not None
    ip = client_ip(request)
    ua = (request.headers.get("user-agent") or "")[:300]
    page = str(body.get("page") or request.headers.get("referer") or "")[:500]
    raw = body.get("values") if isinstance(body.get("values"), dict) else {}
    thanks = form.thanks or "Thank you!"
    mode = form.spam or "Honeypot"

    def store(status: str, **kw) -> CaptureSubmission:
        s = CaptureSubmission(ref=_next_ref(db), form_id=form.id, received_at=now_ist(), is_test=is_test, status=status, ip=ip, user_agent=ua,
                              page_url=page or None, submitted_by=test_user.id if test_user else None,
                              company=str(raw.get("name") or "")[:300] or None, contact=str(raw.get("contact") or "")[:200] or None,
                              email=str(raw.get("email") or "")[:200] or None, phone=str(raw.get("phone") or "")[:40] or None, **kw)
        db.add(s)
        db.flush()
        return s

    if not is_test:
        if _rate(db, ip, None, RATE_TENANT_IP[1]) >= RATE_TENANT_IP[0]:
            raise HTTPException(429, "Too many submissions from your network – please try again later")
        if _rate(db, ip, form.id, RATE_FORM_IP[1]) >= RATE_FORM_IP[0]:
            store("spam", spam_reason="Rate limit: too many submissions from this IP")
            db.commit()
            raise HTTPException(429, "Too many submissions – please try again in a few minutes")

    # spam protection (configured per form)
    if "Honeypot" in mode:
        reason = None
        if str(body.get("hp") or "").strip():
            reason = "Honeypot field filled"
        else:
            rt = _unsign(str(body.get("rt") or ""))
            if not rt or rt.get("k") != form.public_key or rt.get("s") != slug:
                reason = "Missing or invalid form token"
            elif time.time() - int(rt.get("i") or 0) > RENDER_TTL:
                reason = "Form token expired"
            elif time.time() - int(rt.get("i") or 0) < MIN_FILL_SECONDS:
                reason = "Submitted too fast"
        if reason:
            store("spam", spam_reason=reason)
            db.commit()
            if reason == "Form token expired":
                raise HTTPException(409, "This form has expired – reload the page and submit again")
            if is_test:                                  # the admin testing the form sees why it was blocked
                raise HTTPException(422, {"message": f"Blocked by spam protection: {reason}", "fields": {}, "spam": reason})
            return {"ok": True, "thanks": thanks}       # bots get a normal-looking reply
    if "CAPTCHA" in mode and not _captcha_ok(slug, form.public_key, str(body.get("ct") or ""), str(body.get("ca") or "")):
        store("spam", spam_reason="CAPTCHA failed")
        db.commit()
        raise HTTPException(422, {"message": "The answer to the security question is not correct", "fields": {"captcha": "Wrong answer – try the new question"}})

    vals, errs = validate(db, form, raw)
    if errs:
        raise HTTPException(422, {"message": "Please correct the highlighted fields", "fields": errs})

    sub = store("received", data={k: (v if not isinstance(v, dict) else v) for k, v in vals.items()},
                interest=(vals.get("interest") or {}).get("name") if isinstance(vals.get("interest"), dict) else None)
    sub.company = vals.get("name") or None
    sub.contact = vals.get("contact") or None
    sub.email = vals.get("email") or None
    sub.phone = vals.get("phone") or None
    db.commit()
    return process(db, slug, form.id, sub.id, request, test_user=test_user)


def process(db: Session, slug: str, form_id: int, sub_id: int, request: Request, *, test_user: Optional[User] = None) -> dict[str, Any]:
    from app.routers.lead_router import LeadCreate, ProductEntry, create_lead
    form = db.query(CaptureForm).filter(CaptureForm.id == form_id).with_for_update().first()
    sub = db.query(CaptureSubmission).filter(CaptureSubmission.id == sub_id).first()
    vals = dict(sub.data or {})
    is_test = bool(sub.is_test)
    thanks = form.thanks or "Thank you!"
    users = active_users(db)
    prod = vals.get("interest") if isinstance(vals.get("interest"), dict) else None
    state = vals.get("state") if isinstance(vals.get("state"), dict) else None

    customer = find_customer(db, vals.get("name"))
    contact = find_contact(db, customer.id, vals.get("email"), vals.get("phone")) if customer else None
    sub.customer_id = customer.id if customer else None
    sub.contact_id = contact.id if contact else None
    detail = " · ".join(x for x in [
        f"{LABEL[k]}: {(v['name'] if isinstance(v, dict) else v)}" for k, v in vals.items() if v not in (None, "")]) [:1800]

    dup = find_duplicate(db, customer, vals)
    if dup is not None:
        sub.status, sub.lead_id, sub.assigned_to = "duplicate", dup.id, dup.assigned_to
        sub.routing = {"mode": form.assign_mode, "rule": "Duplicate – attached to the existing open lead", "assigned": dup.assigned_to,
                       "assigned_name": users[dup.assigned_to].full_name if dup.assigned_to in users else None,
                       "notes": [f"Open lead {dup.lead_ref_id} already exists for this " + ("customer" if customer else "contact / company")]}
        db.add(LeadNote(lead_id=dup.id, body=f"{'[TEST] ' if is_test else ''}Web form \"{form.name}\" submission {sub.ref} received again – {detail}",
                        created_by=test_user.id if test_user else form.created_by))
        if dup.assigned_to and dup.assigned_to in users:
            try:
                from app.services.notification_service import upsert_notification
                upsert_notification(db, dup.assigned_to, "Repeat web enquiry", f"{vals.get('name') or vals.get('contact') or 'A visitor'} submitted "
                                    f"\"{form.name}\" again – attached to lead {dup.lead_ref_id}.", module="leads", record_id=dup.id,
                                    action="capture_duplicate", send_email=False)
            except Exception as exc:
                logger.warning("capture duplicate notification failed: %s", exc)
        _audit(db, form, sub, request, f"Submission {sub.ref} matched open lead {dup.lead_ref_id}")
        db.commit()
        return {"ok": True, "thanks": thanks, "submission": sub.ref, "status": "duplicate", "lead_id": dup.id, "lead_ref": dup.lead_ref_id,
                "assigned_to": sub.routing["assigned_name"]}

    who, routing = route(db, form, vals)
    actor = users.get(form.created_by) or (users.get(who) if who else None)
    sub.assigned_to, sub.routing = who, routing
    company = vals.get("name") or vals.get("contact") or vals.get("email") or vals.get("phone")
    title = (prod["name"] if prod else f"Web enquiry – {company}")[:480]
    try:
        if actor is None:
            raise HTTPException(409, "The form owner is no longer active – reassign the form")
        payload = LeadCreate(
            customer_id=customer.id if customer else None, customer_name=(customer.customer_name if customer else company),
            customer_address=state["name"] if state and not customer else None,
            contact_person=(contact.contact_name if contact else vals.get("contact")) or None,
            designation=contact.designation if contact else None, department=contact.department if contact else None,
            mobile=vals.get("phone") or (contact.mobile if contact else None), email=vals.get("email") or (contact.office_email if contact else None),
            lead_title=("[TEST] " if is_test else "") + title, source_id=form.source_id, est_value=float(vals.get("value") or 0),
            assigned_to=who, notes=(("[TEST SUBMISSION] " if is_test else "") + f"Web form \"{form.name}\" · {sub.ref}\n"
                                    + (str(vals.get("message")) if vals.get("message") else ""))[:5000],
            tender_id_ref=vals.get("tender") or None, products=[ProductEntry(product_id=prod["id"], product_name=prod["name"])] if prod else [],
            lead_type="lead",
        )
        request.state.tenant_slug = slug
        lead = create_lead(payload, request, db=db, cu=actor)
        lead_id = lead["id"] if isinstance(lead, dict) else lead.id
        row = db.query(Lead).filter(Lead.id == lead_id).first()
        row.custom_data = {**(row.custom_data or {}), "capture_form": form.name, "capture_form_id": form.id, "capture_submission": sub.ref,
                           **({"test_submission": True} if is_test else {})}
        if contact:
            db.merge(LeadContactLink(lead_id=lead_id, contact_id=contact.id))
        sub = db.query(CaptureSubmission).filter(CaptureSubmission.id == sub_id).first()
        sub.status, sub.lead_id, sub.assigned_to, sub.routing = "lead_created", lead_id, row.assigned_to, routing
        sub.customer_id = customer.id if customer else None
        sub.contact_id = contact.id if contact else None
        if row.assigned_to != who:
            routing["assigned"] = row.assigned_to
            routing["assigned_name"] = users[row.assigned_to].full_name if row.assigned_to in users else None
            sub.routing = dict(routing)
        f2 = db.query(CaptureForm).filter(CaptureForm.id == form_id).first()
        f2.rr_cursor = form.rr_cursor
        _audit(db, f2, sub, request, f"Submission {sub.ref} → lead {row.lead_ref_id}" + (" (test)" if is_test else ""))
        db.commit()
        return {"ok": True, "thanks": thanks, "submission": sub.ref, "status": "lead_created", "lead_id": lead_id, "lead_ref": row.lead_ref_id,
                "assigned_to": routing.get("assigned_name")}
    except Exception as exc:
        db.rollback()
        msg = exc.detail if isinstance(exc, HTTPException) else str(exc)
        logger.warning("capture form %s submission %s: lead creation failed: %s", form_id, sub_id, msg)
        sub = db.query(CaptureSubmission).filter(CaptureSubmission.id == sub_id).first()
        sub.status, sub.error, sub.assigned_to, sub.routing = "error", str(msg)[:2000], who, routing
        sub.customer_id = customer.id if customer else None
        db.commit()
        # the visitor's enquiry is stored; the team sees the error in Recent submissions
        return {"ok": True, "thanks": thanks, "submission": sub.ref, "status": "error", "error": str(msg)[:300]}


def _audit(db: Session, form: CaptureForm, sub: CaptureSubmission, request: Request, text_: str) -> None:
    try:
        from app.dependencies import get_request_ip
        log_audit_db(db, sub.submitted_by or form.created_by, "capture_forms", "submission", form.id, get_request_ip(request), text_,
                     new_data={"submission": sub.ref, "status": sub.status, "lead_id": sub.lead_id, "test": bool(sub.is_test)}, record_name=form.name)
    except Exception as exc:
        logger.warning("capture audit failed: %s", exc)


# ─── KPIs ─────────────────────────────────────────────────────────────────────

def stats(db: Session, days: int = 30) -> dict[str, Any]:
    since = now_ist() - timedelta(days=days)
    rows = (db.query(CaptureSubmission.form_id, CaptureSubmission.status, CaptureSubmission.received_at, Lead.status)
            .outerjoin(Lead, Lead.id == CaptureSubmission.lead_id)
            .filter(CaptureSubmission.is_test == False, CaptureSubmission.received_at >= since).all())
    per: dict[int, dict[str, int]] = defaultdict(lambda: {"subs": 0, "leads": 0, "won": 0})
    spam = 0
    buckets = [0] * 10                                 # sparkline: 10 × 3-day buckets
    for fid, st, at, lst in rows:
        if st == "spam":
            spam += 1
            continue
        per[fid]["subs"] += 1
        if at:
            i = min(9, max(0, int((at - since).total_seconds() // (3 * 86400))))
            buckets[i] += 1
        if st == "lead_created":
            per[fid]["leads"] += 1
            if lst in ("Opportunity Created", "Converted"):
                per[fid]["won"] += 1
    for v in per.values():
        v["conv"] = round(v["won"] * 100 / v["leads"]) if v["leads"] else 0
    return {"per": dict(per), "spam": spam, "spark": buckets,
            "subs": sum(v["subs"] for v in per.values()), "leads": sum(v["leads"] for v in per.values()), "won": sum(v["won"] for v in per.values())}
