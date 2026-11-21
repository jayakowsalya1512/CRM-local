"""Application settings (prototype v17 "p25" Settings page) – schema, defaults, validation and persistence.

Design
- The settings *schema* (categories → groups → fields, prototype SETC) lives here once; the API returns it with the
  values so the page renders exactly like the prototype from a single GET.
- Only customised values are stored (app_settings).  Defaults come from the schema and – for identity-type fields –
  from the tenant master row (legal name, address, support e-mail, session timeout …) so the page is never empty.
- A handful of keys are "write-through": saving them also updates the authoritative column on the master tenant row
  (or the theme store) so the rest of the product – login policy, header company name, accent colour – follows.
- Loading = 1 query on app_settings (+ the master tenant row the request already resolved).  No per-field queries.
- The GET payload is cached in Redis under theme:<slug>:app_settings (invalidated by every write here and by the
  legacy settings/theme writers, which clear theme:<slug>:*).
"""
from __future__ import annotations

import json
import logging
import re
import threading
from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException

from app.core import validators as V
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.timezone import now_ist
from app.models.all_models import TenantSetting, User, UserSession
from app.models.app_settings import APP_SETTINGS_TABLES, AppSetting, AppSettingChange
from app.models.tenant import Plan, Tenant
from app.services.cache_service import (
    CACHE_TTL_SECONDS,
    cache_delete,
    cache_get_json,
    cache_set_json,
    tenant_slug_from_db,
    theme_cache_key,
)

logger = logging.getLogger(__name__)

_READY: set[str] = set()
_LOCK = threading.Lock()

TIME_ZONES = [
    "Asia/Kolkata (IST, UTC+5:30)", "Asia/Dubai (GST, UTC+4)", "Europe/London (GMT/BST)",
    "America/New_York (EST)", "Asia/Singapore (SGT)",
]


def sf(k: str, l: str, t: str, d: Any, o: Optional[list] = None, h: str = "") -> dict:
    """Schema field – prototype sf(k,l,t,d,o,h): key, label, type, default, options, help."""
    f = {"k": k, "l": l, "t": t, "d": d}
    if o is not None:
        f["o"] = o
    if h:
        f["h"] = h
    return f


# Prototype SETC – categories, groups and fields (ids and labels verbatim).
SCHEMA: list[dict] = [
    {"id": "company", "n": "Company profile", "i": "building", "d": "Legal identity, registrations and address", "g": [
        ["Identity", [
            sf("legal", "Legal name", "text", ""), sf("trade", "Trade name", "text", ""),
            sf("gstin", "GSTIN", "text", "", None, "Printed on quotations and invoices"), sf("pan", "PAN", "text", ""),
            sf("cin", "CIN", "text", ""),
            sf("industry", "Primary industry", "select", "Power & Energy",
               ["Power & Energy", "Rail & Metro", "Defence", "Water & Utilities", "Oil & Gas", "Infrastructure"]),
        ]],
        ["Address & contact", [
            sf("addr", "Registered address", "textarea", ""), sf("city", "City", "text", ""),
            sf("state", "State", "select", "Tamil Nadu",
               ["Tamil Nadu", "Kerala", "Karnataka", "Maharashtra", "Gujarat", "Delhi", "Telangana"]),
            sf("pin", "Pincode", "text", ""), sf("phone", "Phone", "text", ""), sf("web", "Website", "text", ""),
            sf("mail", "Support e-mail", "text", ""),
        ]],
        ["Financial year", [
            sf("fy", "Financial year starts", "select", "April", ["April", "January", "July", "October"]),
            sf("emp", "Employees", "number", 0),
        ]],
    ]},
    {"id": "branding", "n": "Branding & appearance", "i": "layout", "d": "Colours, logo and how the workspace looks", "g": [
        ["Brand", [
            sf("color", "Brand colour", "color", "#0F6E8C"), sf("logo", "Company logo", "file", ""),
            sf("fav", "Favicon", "file", ""), sf("loginMsg", "Login page headline", "text", "Win more tenders. Deliver on time."),
            sf("quoteLogo", "Show logo on quotations & letters", "switch", True),
        ]],
        ["Workspace", [
            sf("theme", "Default theme", "select", "Light", ["Light", "Dark", "Match system"]),
            sf("dens", "Density", "select", "Comfortable", ["Comfortable", "Compact"]),
            sf("sidebar", "Sidebar", "select", "Dark", ["Dark", "Light"]), sf("anim", "Interface animations", "switch", True),
        ]],
    ]},
    {"id": "locale", "n": "Language & regional", "i": "globe", "d": "Language, time zone, formats and currencies", "g": [
        ["Regional formats", [
            sf("lang", "Language", "select", "English (India)", ["English (India)", "English (UK)", "हिन्दी", "தமிழ்", "മലയാളം"]),
            sf("tz", "Time zone", "select", TIME_ZONES[0], TIME_ZONES),
            sf("dfmt", "Date format", "select", "DD MMM YYYY", ["DD MMM YYYY", "DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]),
            sf("tfmt", "Time format", "select", "24-hour", ["24-hour", "12-hour"]),
            sf("nfmt", "Number grouping", "select", "Indian (lakh / crore)", ["Indian (lakh / crore)", "International (million)"]),
            sf("wk", "Week starts on", "select", "Monday", ["Monday", "Sunday", "Saturday"]),
        ]],
        ["Currency", [
            sf("base", "Base currency", "select", "INR – Indian Rupee", ["INR – Indian Rupee", "USD – US Dollar", "EUR – Euro", "AED – UAE Dirham"]),
            sf("multi", "Allow quotes in other currencies", "switch", True), sf("fxauto", "Update exchange rates daily", "switch", True),
            sf("fxsrc", "Rate source", "select", "RBI reference rate", ["RBI reference rate", "ECB", "Manual only"]),
        ]],
        ["Exchange rates (1 unit = ₹)", [
            sf("fxUSD", "USD", "number", 83.4), sf("fxEUR", "EUR", "number", 90.1),
            sf("fxGBP", "GBP", "number", 105.6), sf("fxAED", "AED", "number", 22.7),
        ]],
    ]},
    {"id": "hours", "n": "Business hours & holidays", "i": "clock", "d": "Working time used for SLAs, escalations and reminders", "g": [
        ["Working time", [
            sf("days", "Working days", "chips", "Mon,Tue,Wed,Thu,Fri,Sat", ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
            sf("from", "Day starts", "time", "09:30"), sf("to", "Day ends", "time", "18:00"),
            sf("lunch", "Lunch break", "text", "13:00 – 14:00"),
            sf("sla", "Count SLA timers only in business hours", "switch", True), sf("esc2", "Pause escalations on holidays", "switch", True),
        ]],
        ["Holidays 2026", [
            sf("hol", "Holiday calendar", "list", ["26 Jan – Republic Day", "14 Apr – Tamil New Year", "15 Aug – Independence Day",
                                                   "02 Oct – Gandhi Jayanti", "31 Oct – Diwali", "01 Nov – Diwali holiday", "25 Dec – Christmas"]),
        ]],
    ]},
    {"id": "security", "n": "Security & sign-in", "i": "lock", "d": "Passwords, MFA, single sign-on and network access", "g": [
        ["Passwords", [
            sf("pmin", "Minimum length", "number", 10), sf("pcx", "Require upper, lower, number and symbol", "switch", True),
            sf("pexp", "Password expires after (days)", "number", 90), sf("phist", "Disallow last N passwords", "number", 5),
        ]],
        ["Multi-factor & sessions", [
            sf("mfa", "Multi-factor authentication", "select", "Required for everyone", ["Off", "Admins only", "Required for everyone"]),
            sf("sess", "Session timeout (minutes)", "number", 30), sf("conc", "Concurrent sessions per user", "number", 3),
            sf("lock", "Lock account after failed attempts", "number", 5), sf("dev", "Approve new devices", "switch", True),
            sf("notifyLogin", "Email users on new sign-in", "switch", True),
        ]],
        ["Single sign-on", [
            sf("sso", "Provider", "select", "Off", ["Off", "Microsoft Entra ID (Azure AD)", "Google Workspace", "Okta", "Custom SAML 2.0"]),
            sf("ssoUrl", "Metadata URL", "text", ""), sf("ssoForce", "Force SSO for everyone except admins", "switch", False),
            sf("scim", "Automatic user provisioning (SCIM)", "switch", False),
        ]],
        ["Network", [
            sf("ips", "Allowed IP ranges (one per line)", "textarea", ""), sf("ipOn", "Block sign-in from other networks", "switch", False),
            sf("api", "API token expiry (days)", "number", 90),
        ]],
    ]},
    {"id": "privacy", "n": "Data & privacy", "i": "shield", "d": "Retention, residency, masking and backups", "g": [
        ["Retention", [
            sf("rLeads", "Leads and contacts", "select", "7 years", ["3 years", "5 years", "7 years", "Forever"]),
            sf("rAct", "Activities and notes", "select", "3 years", ["1 year", "3 years", "7 years", "Forever"]),
            sf("rMail", "Emails", "select", "2 years", ["1 year", "2 years", "5 years", "Forever"]),
            sf("rDoc", "Documents", "select", "8 years", ["5 years", "8 years", "10 years", "Forever"]),
            sf("rAudit", "Audit log", "select", "7 years", ["1 year", "3 years", "7 years"]),
            sf("bin", "Recycle bin keeps items for (days)", "number", 60), sf("arch", "Auto-archive closed deals after (months)", "number", 18),
        ]],
        ["Privacy", [
            sf("mask", "Mask phone and e-mail for roles without access", "switch", True), sf("consent", "Track marketing consent on contacts", "switch", True),
            sf("erase", "Allow right-to-erasure requests", "switch", True),
            sf("resid", "Data residency", "select", "India – Mumbai", ["India – Mumbai", "India – Hyderabad", "Singapore", "Frankfurt"]),
        ]],
        ["Backups", [
            sf("bk", "Daily backup at", "time", "02:00"), sf("bkr", "Keep backups for (days)", "number", 35), sf("bkenc", "Encrypt backups", "switch", True),
        ]],
    ]},
    {"id": "notify", "n": "Notifications", "i": "bell", "d": "Which events notify whom and how", "matrix": True, "g": [
        ["Delivery", [
            sf("digest", "Daily digest at", "time", "08:30"),
            sf("weekly", "Weekly summary", "select", "Monday 08:00", ["Off", "Monday 08:00", "Friday 17:00"]),
            sf("qh", "Quiet hours", "text", "21:00 – 07:00"), sf("esc", "Remind again after (hours)", "number", 12),
            sf("sender", "Sender name", "text", ""),
        ]],
    ]},
    {"id": "email", "n": "Email & calendar", "i": "mail", "d": "Sending identity, tracking and calendar sync", "g": [
        ["Sending", [
            sf("from", "Default from name", "text", ""), sf("reply", "Reply-to address", "text", ""),
            sf("sig", "Company signature", "textarea", ""), sf("trkO", "Track email opens", "switch", True),
            sf("trkC", "Track link clicks", "switch", True), sf("bcc", "Always BCC the CRM dropbox", "switch", True),
            sf("autolog", "Automatically log emails to records", "switch", True),
        ]],
        ["Calendar & meetings", [
            sf("cal", "Calendar sync", "select", "Off", ["Off", "Google Calendar", "Microsoft 365", "iCloud"]),
            sf("meet", "Default meeting link", "select", "Google Meet", ["Google Meet", "Microsoft Teams", "Zoom"]),
            sf("buf", "Buffer between meetings (min)", "number", 15), sf("book", "Public booking page for customers", "switch", False),
        ]],
    ]},
    {"id": "number", "n": "Numbering & documents", "i": "doc", "d": "Record number formats and document rules", "series": True, "g": [
        ["Document storage", [
            sf("maxmb", "Maximum upload size (MB)", "number", 50),
            sf("types", "Allowed file types", "text", "pdf, docx, xlsx, pptx, jpg, png, zip, dwg"),
            sf("ver", "Keep version history", "switch", True), sf("vscan", "Scan uploads for viruses", "switch", True),
            sf("wm", "Watermark downloaded copies with user name", "switch", False),
        ]],
        ["Quotation defaults", [
            sf("qvalid", "Validity (days)", "number", 30),
            sf("qnote", "Footer note", "textarea", "Prices are valid for the period stated. GST extra as applicable."),
            sf("qtc", "Default terms & conditions", "select", "Standard supply terms", ["Standard supply terms", "Turnkey EPC terms", "AMC terms"]),
        ]],
    ]},
    {"id": "tax", "n": "Taxes & pricing defaults", "i": "wallet", "d": "GST, rounding, discount limits and guarantees", "g": [
        ["Tax", [
            sf("reg", "Tax regime", "select", "GST (India)", ["GST (India)", "VAT", "None"]),
            sf("gst", "Default GST rate (%)", "select", "18", ["0", "5", "12", "18", "28"]),
            sf("hsn", "Default HSN / SAC", "text", "8537"), sf("tds", "Default TDS (%)", "number", 2),
            sf("round", "Round totals to", "select", "Nearest ₹1", ["Nearest ₹1", "Nearest ₹10", "No rounding"]),
            sf("einv", "Generate e-invoice IRN", "switch", True),
        ]],
        ["Pricing rules", [
            sf("pay", "Default payment terms", "select", "30 days", ["Advance", "30 days", "45 days", "60 days", "80:20"]),
            sf("dKAM", "Discount limit – KAM (%)", "number", 5), sf("dMGR", "Discount limit – Manager (%)", "number", 10),
            sf("dSH", "Discount limit – Sales Head (%)", "number", 15), sf("emdp", "Default EMD (% of tender value)", "number", 2),
            sf("pbg", "Default performance guarantee (%)", "number", 5),
        ]],
    ]},
    {"id": "mobile", "n": "Mobile app", "i": "layout", "d": "Policies for your team’s mobile app (can only be stricter than the platform)", "devices": True, "g": [
        ["Policies", [
            sf("moOn", "Mobile app enabled for my company", "switch", True), sf("moOff", "Offline mode", "switch", True),
            sf("moGps", "Require GPS for check-in", "switch", True), sf("moBio", "Require biometric unlock", "switch", True),
            sf("moShot", "Block screenshots", "switch", False), sf("moDev", "Approve new devices", "switch", True),
            sf("moMax", "Maximum devices per user", "number", 3), sf("moSess", "Auto-logout after (minutes)", "number", 30),
            sf("moPush", "Push notifications", "switch", True),
        ]],
    ]},
    {"id": "billing", "n": "Plan & billing", "i": "card", "d": "Subscription, usage and invoices", "billing": True, "g": [
        ["Billing contact", [
            sf("bname", "Billing contact", "text", ""), sf("bmail", "Billing e-mail", "text", ""),
            sf("bgst", "GSTIN on invoices", "text", ""), sf("bpo", "Purchase order reference", "text", ""),
        ]],
    ]},
    {"id": "history", "n": "Change history", "i": "doc", "d": "Who changed which setting and when", "history": True, "g": []},
]

# Notification matrix (prototype NEVT × NCH, defaults NDEF) and number series (SERD) – stored as JSON values
# under the special keys below so "Reset to defaults" of the category clears them together with its fields.
NOTIFY_EVENTS = ["Bid deadline approaching", "Guarantee expiring", "Approval requested", "Approval decided", "Lead assigned to me",
                 "Task due", "I am mentioned", "Order milestone due", "Payment received", "Announcement posted"]
NOTIFY_CHANNELS = ["In-app", "Email", "Push", "WhatsApp", "SMS"]
NOTIFY_DEFAULTS = [[1, 1, 1, 0, 0], [1, 1, 1, 1, 0], [1, 1, 1, 0, 0], [1, 1, 0, 0, 0], [1, 0, 1, 0, 0],
                   [1, 0, 1, 0, 0], [1, 1, 1, 0, 0], [1, 1, 0, 0, 0], [1, 1, 0, 1, 0], [1, 0, 0, 0, 0]]
MATRIX_KEY = "matrix"
SERIES_KEY = "series"
SERIES_DEFAULTS = [  # record, prefix, suffix, digits, next, restart yearly
    {"r": "Lead", "p": "LD-", "s": "", "d": 5, "n": 1, "y": True}, {"r": "Deal", "p": "DL-", "s": "", "d": 5, "n": 1, "y": True},
    {"r": "Tender", "p": "TND-", "s": "/26", "d": 4, "n": 1, "y": True}, {"r": "Quotation", "p": "QTN-", "s": "/26", "d": 4, "n": 1, "y": True},
    {"r": "Work order", "p": "WO-", "s": "/26", "d": 4, "n": 1, "y": True}, {"r": "Invoice", "p": "INV/", "s": "/26", "d": 5, "n": 1, "y": True},
    {"r": "Guarantee", "p": "BG-", "s": "", "d": 5, "n": 1, "y": False},
]

CATEGORIES: dict[str, dict] = {c["id"]: c for c in SCHEMA}
FIELDS: dict[tuple[str, str], dict] = {(c["id"], f["k"]): f for c in SCHEMA for _, fs in c["g"] for f in fs}
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
TEXT_MAX = 2000


# ─── schema sync ──────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        for t in APP_SETTINGS_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant.slug).all()]
    except Exception as exc:  # pragma: no cover
        logger.warning("App settings schema sync: unable to list tenants: %s", exc)
        return
    finally:
        master.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_schema(db)
            finally:
                db.close()
        except Exception as exc:
            logger.warning("App settings schema sync failed for %s: %s", slug, exc)


# ─── defaults ─────────────────────────────────────────────────────────────────

def _theme_value(db: Session, key: str) -> str:
    row = db.query(TenantSetting.value).filter(TenantSetting.key == key).first()
    return (row[0] or "") if row else ""


def tenant_defaults(db: Session, tenant: Optional[Tenant]) -> dict[str, dict[str, Any]]:
    """Defaults that come from the tenant master row – keyed category → key → value."""
    if tenant is None:
        return {}
    addr = (tenant.street_address or tenant.address or "").strip()
    logo = _theme_value(db, "theme_logo")
    accent = _theme_value(db, "theme_accent") or tenant.primary_color or "#0F6E8C"
    out: dict[str, dict[str, Any]] = {
        "company": {"legal": tenant.name or "", "trade": tenant.name or "", "industry": tenant.industry or "Power & Energy",
                    "addr": addr, "city": tenant.city_district or "", "state": tenant.state or "Tamil Nadu",
                    "pin": tenant.pincode or "", "mail": tenant.company_mail or tenant.admin_email or ""},
        "branding": {"color": accent if _HEX.match(accent or "") else "#0F6E8C", "logo": logo.rsplit("/", 1)[-1] if logo else ""},
        "security": {"pexp": int(tenant.password_expiry_days or 0) if tenant.password_expiry_enabled else 0,
                     "sess": int(tenant.inactivity_timeout_minutes or 30),
                     "notifyLogin": bool(tenant.new_device_login_alert_enabled)},
        "notify": {"sender": f"{tenant.name} CRM" if tenant.name else ""},
        "email": {"from": tenant.name or "", "reply": tenant.from_email or tenant.company_mail or ""},
        "billing": {"bname": tenant.admin_name or "", "bmail": tenant.billing_email or tenant.admin_email or ""},
    }
    return out


def default_for(cat: str, key: str, dyn: dict[str, dict[str, Any]]) -> Any:
    if key == MATRIX_KEY and cat == "notify":
        return [[bool(x) for x in row] for row in NOTIFY_DEFAULTS]
    if key == SERIES_KEY and cat == "number":
        return [dict(r) for r in SERIES_DEFAULTS]
    if cat in dyn and key in dyn[cat]:
        return dyn[cat][key]
    f = FIELDS.get((cat, key))
    return f["d"] if f else None


# ─── load ─────────────────────────────────────────────────────────────────────

def _cache_key(db: Session) -> str:
    slug = tenant_slug_from_db(db)
    return theme_cache_key(slug, "app_settings") if slug else ""


def invalidate(db: Session) -> None:
    key = _cache_key(db)
    if key:
        cache_delete(key)


def load(db: Session, tenant: Optional[Tenant]) -> dict:
    """Everything the Settings page needs in one payload (schema + effective values + matrix + series)."""
    ck = _cache_key(db)
    if ck:
        cached = cache_get_json(ck, "app_settings")
        if cached is not None:
            return cached
    ensure_schema(db)
    dyn = tenant_defaults(db, tenant)
    values: dict[str, dict[str, Any]] = {}
    customised: dict[str, list[str]] = {}
    for c in SCHEMA:
        values[c["id"]] = {f["k"]: default_for(c["id"], f["k"], dyn) for _, fs in c["g"] for f in fs}
    values["notify"][MATRIX_KEY] = default_for("notify", MATRIX_KEY, dyn)
    values["number"][SERIES_KEY] = default_for("number", SERIES_KEY, dyn)
    for row in db.query(AppSetting.category, AppSetting.key, AppSetting.value).all():  # single query – overrides only
        if row.category in values and (row.key in values[row.category]):
            values[row.category][row.key] = row.value
            customised.setdefault(row.category, []).append(row.key)
    payload = {
        "tenant": {"name": tenant.name if tenant else "", "slug": tenant.slug if tenant else ""},
        "categories": SCHEMA,
        "values": values,
        "customised": customised,
        "matrix": {"events": NOTIFY_EVENTS, "channels": NOTIFY_CHANNELS},
    }
    if ck:
        cache_set_json(ck, payload, CACHE_TTL_SECONDS["theme"])
    return payload


# ─── validation ───────────────────────────────────────────────────────────────

def _bad(msg: str) -> HTTPException:
    return HTTPException(status_code=422, detail=msg)


# Per-field rules for text / number settings (mirrors RULES in frontend/src/pages/settings/AppSettingsPage.tsx).
# number: (min, max, integer_only)
NUMBER_RULES: dict[str, tuple[float, float, bool]] = {
    "emp": (0, 10_000_000, True),
    "fxUSD": (0.0001, 100_000, False), "fxEUR": (0.0001, 100_000, False), "fxGBP": (0.0001, 100_000, False), "fxAED": (0.0001, 100_000, False),
    "pmin": (6, 64, True), "pexp": (0, 3650, True), "phist": (0, 24, True), "sess": (1, 1440, True), "conc": (1, 50, True),
    "lock": (1, 50, True), "api": (1, 3650, True), "bin": (1, 3650, True), "arch": (1, 600, True), "bkr": (1, 3650, True),
    "esc": (0, 720, True), "buf": (0, 240, True), "maxmb": (1, 1024, True), "qvalid": (1, 3650, True),
    "tds": (0, 100, False), "dKAM": (0, 100, False), "dMGR": (0, 100, False), "dSH": (0, 100, False),
    "emdp": (0, 100, False), "pbg": (0, 100, False), "moMax": (1, 50, True), "moSess": (1, 1440, True),
}
_HSN = re.compile(r"^\d{4,8}$")
_CIN = re.compile(r"^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$")


def _text_rule(key: str, label: str, v: str) -> str:
    """Format check for a text setting; returns the cleaned value or raises a field error on ``value``."""
    try:
        if not v.strip():
            if v and key in ("legal", "trade", "city", "sender", "from", "bname", "loginMsg"):
                raise ValueError(f"{label} cannot be blank or only spaces.")
            return ""
        if key in ("gstin", "bgst"):
            return V.check_gstin(v) or ""
        if key == "pan":
            return V.check_pan(v) or ""
        if key == "pin":
            return V.check_pincode(v) or ""
        if key == "phone":
            return V.check_mobile(v, label) or ""
        if key in ("web", "ssoUrl"):
            return V.check_url(v) or ""
        if key in ("mail", "reply", "bmail"):
            return V.check_email(v) or ""
        if key == "cin":
            s = v.strip().upper()
            if not _CIN.match(s):
                raise ValueError("Enter a valid 21-character CIN (e.g. U72900KA2015PTC123456).")
            return s
        if key == "hsn":
            s = v.strip()
            if not _HSN.match(s):
                raise ValueError("HSN / SAC must be 4 to 8 digits.")
            return s
        if key in ("legal", "trade", "bname"):
            return V.check_text(v, label, 2, 200) or ""
        if key in ("city", "sender", "from"):
            return V.check_text(v, label, 2, 100) or ""
        return v
    except ValueError as exc:
        raise V.field_error("value", str(exc))


def _number_rule(key: str, label: str, n: float) -> None:
    rule = NUMBER_RULES.get(key)
    lo, hi, whole = rule if rule else (0, 1e12, False)
    if n < 0:
        raise V.field_error("value", f"{label} cannot be negative.")
    if whole and not float(n).is_integer():
        raise V.field_error("value", f"{label} must be a whole number.")
    if n < lo or n > hi:
        raise V.field_error("value", f"{label} must be between {lo:g} and {hi:g}.")


def normalize(cat: str, key: str, value: Any) -> Any:
    """Coerce + validate an incoming value for (category, key).  Raises 422 on bad input."""
    if cat not in CATEGORIES:
        raise HTTPException(status_code=404, detail="Unknown settings section")
    if cat == "notify" and key == MATRIX_KEY:
        if not (isinstance(value, list) and len(value) == len(NOTIFY_EVENTS)
                and all(isinstance(r, list) and len(r) == len(NOTIFY_CHANNELS) for r in value)):
            raise _bad("Notification matrix must be events × channels")
        return [[bool(x) for x in r] for r in value]
    if cat == "number" and key == SERIES_KEY:
        if not isinstance(value, list) or len(value) != len(SERIES_DEFAULTS):
            raise _bad("Number series must list every record type")
        out = []
        for d, r in zip(SERIES_DEFAULTS, value):
            if not isinstance(r, dict):
                raise _bad("Invalid number series row")
            p, s = str(r.get("p", d["p"]))[:20], str(r.get("s", d["s"]))[:20]
            try:
                dg, nx = int(r.get("d", d["d"])), int(r.get("n", d["n"]))
            except (TypeError, ValueError):
                raise _bad("Digits and next number must be whole numbers")
            if not 1 <= dg <= 12 or nx < 0:
                raise _bad("Digits must be 1–12 and next number ≥ 0")
            out.append({"r": d["r"], "p": p, "s": s, "d": dg, "n": nx, "y": bool(r.get("y", d["y"]))})
        return out
    f = FIELDS.get((cat, key))
    if not f:
        raise HTTPException(status_code=404, detail="Unknown setting")
    t = f["t"]
    if t == "switch":
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "on", "yes"}
        return bool(value)
    if t == "number":
        try:
            n = float(value)
        except (TypeError, ValueError):
            raise _bad(f"{f['l']} must be a number")
        if n != n or abs(n) > 1e12:
            raise _bad(f"{f['l']} is out of range")
        _number_rule(key, f["l"], n)
        return int(n) if n.is_integer() else n
    if t == "select":
        v = str(value if value is not None else "")
        if v not in f.get("o", []):
            raise _bad(f"{f['l']}: choose one of the listed options")
        return v
    if t == "chips":
        items = value if isinstance(value, list) else str(value or "").split(",")
        chosen = [o for o in f.get("o", []) if o in {str(x).strip() for x in items}]
        return ",".join(chosen)
    if t == "list":
        if not isinstance(value, list):
            raise _bad(f"{f['l']} must be a list")
        items = [str(x).strip()[:160] for x in value if str(x).strip()]
        if len(items) > 200:
            raise _bad(f"{f['l']} can hold at most 200 entries")
        return items
    if t == "time":
        v = str(value or "").strip()
        if not _TIME.match(v):
            raise _bad(f"{f['l']} must be HH:MM")
        return v
    if t == "color":
        v = str(value or "").strip()
        if not _HEX.match(v):
            raise _bad(f"{f['l']} must be a hex colour like #0F6E8C")
        return v.upper()
    if t == "file":
        return str(value or "")[:255]
    v = str(value if value is not None else "")
    if len(v) > TEXT_MAX:
        raise _bad(f"{f['l']} is too long")
    if t == "text":
        return _text_rule(key, f["l"], v).strip()
    return v


def display(value: Any) -> str:
    """Human form for the change log (prototype: On / Off, lists joined)."""
    if value is True:
        return "On"
    if value is False:
        return "Off"
    if value is None:
        return "—"
    if isinstance(value, list):
        if value and isinstance(value[0], list):
            return f"{sum(1 for r in value for x in r if x)} channels on"
        if value and isinstance(value[0], dict):
            return "; ".join(f"{r.get('p', '')}{str(r.get('n', 1)).zfill(int(r.get('d', 1)))}{r.get('s', '')}" for r in value)
        return ", ".join(str(x) for x in value) or "—"
    s = str(value)
    return s if len(s) <= 120 else s[:117] + "…"


# ─── write ────────────────────────────────────────────────────────────────────

def _log(db: Session, user: Optional[User], cat: str, key: str, label: str, old: Any, new: Any) -> AppSettingChange:
    row = AppSettingChange(category=cat, section=CATEGORIES[cat]["n"], setting_key=key, label=label,
                           old_value=display(old), new_value=display(new),
                           changed_by=user.id if user else None, changed_by_name=(user.full_name if user else None),
                           created_at=now_ist())
    db.add(row)
    return row


def _write_through(db: Session, master_db: Session, tenant: Optional[Tenant], cat: str, key: str, value: Any) -> None:
    """Keep the authoritative product columns in sync with the setting that owns them."""
    if tenant is None:
        return
    if cat == "company":
        col = {"mail": "company_mail", "addr": "street_address", "city": "city_district", "state": "state",
               "pin": "pincode", "industry": "industry"}.get(key)
        if col:
            setattr(tenant, col, (str(value).strip() or None))
        if key == "legal":
            _upsert_theme(db, "company_name", str(value))
    elif cat == "security":
        if key == "pexp":
            days = int(value or 0)
            tenant.password_expiry_enabled = days > 0
            if days > 0:
                tenant.password_expiry_days = days
        elif key == "sess":
            tenant.inactivity_timeout_minutes = max(1, int(value or 30))
        elif key == "notifyLogin":
            tenant.new_device_login_alert_enabled = bool(value)
    elif cat == "branding" and key == "color":
        _upsert_theme(db, "theme_accent", str(value))
        tenant.primary_color = str(value)
    elif cat == "billing" and key == "bmail":
        tenant.billing_email = str(value).strip() or None


def _upsert_theme(db: Session, key: str, value: str) -> None:
    row = db.query(TenantSetting).filter(TenantSetting.key == key).first()
    if row:
        row.value, row.updated_at = value, now_ist()
    else:
        db.add(TenantSetting(key=key, value=value, value_type="string", updated_at=now_ist()))


def save(db: Session, master_db: Session, tenant: Optional[Tenant], user: User, cat: str, key: str, raw: Any) -> dict:
    ensure_schema(db)
    value = normalize(cat, key, raw)
    dyn = tenant_defaults(db, tenant)
    row = db.query(AppSetting).filter(AppSetting.category == cat, AppSetting.key == key).first()
    old = row.value if row else default_for(cat, key, dyn)
    if row:
        row.value, row.updated_by, row.updated_at = value, user.id, now_ist()
    else:
        db.add(AppSetting(category=cat, key=key, value=value, updated_by=user.id, updated_at=now_ist()))
    label = FIELDS[(cat, key)]["l"] if (cat, key) in FIELDS else ("Who is notified" if key == MATRIX_KEY else "Number series")
    change = _log(db, user, cat, key, label, old, value)
    _write_through(db, master_db, tenant, cat, key, value)
    db.commit()
    master_db.commit()
    invalidate(db)
    if cat in ("company", "branding", "security"):
        from app.services.cache_service import invalidate_theme_cache
        invalidate_theme_cache(db)
    return {"category": cat, "key": key, "value": value, "label": label, "change": change_dict(change)}


def reset(db: Session, master_db: Session, tenant: Optional[Tenant], user: User, cat: str) -> dict:
    if cat not in CATEGORIES:
        raise HTTPException(status_code=404, detail="Unknown settings section")
    ensure_schema(db)
    n = db.query(AppSetting).filter(AppSetting.category == cat).delete(synchronize_session=False)
    dyn = tenant_defaults(db, tenant)
    if tenant is not None:  # write-through keys follow the reset
        for key in [k for (c, k) in FIELDS if c == cat]:
            _write_through(db, master_db, tenant, cat, key, default_for(cat, key, dyn))
    _log(db, user, cat, "*", "Section", "customised", "defaults")
    db.commit()
    master_db.commit()
    invalidate(db)
    from app.services.cache_service import invalidate_theme_cache
    invalidate_theme_cache(db)
    return {"category": cat, "removed": int(n)}


def change_dict(r: AppSettingChange) -> dict:
    return {"id": r.id, "t": r.created_at.isoformat() if r.created_at else None, "u": r.changed_by_name or "System",
            "s": r.section, "c": r.label, "o": r.old_value or "—", "n": r.new_value or "—", "cat": r.category, "k": r.setting_key}


def history(db: Session, offset: int, limit: int, cat: Optional[str] = None) -> dict:
    ensure_schema(db)
    q = db.query(AppSettingChange)
    if cat:
        q = q.filter(AppSettingChange.category == cat)
    total = q.with_entities(func.count(AppSettingChange.id)).scalar() or 0
    rows = q.order_by(AppSettingChange.created_at.desc(), AppSettingChange.id.desc()).offset(offset).limit(limit).all()
    return {"items": [change_dict(r) for r in rows], "total": int(total), "offset": offset, "limit": limit}


# ─── side panels (mobile devices, plan & billing) ─────────────────────────────

def devices(db: Session, limit: int = 50) -> list[dict]:
    """Registered devices = active sign-in sessions, newest activity first (one JOIN, no per-row lookups)."""
    rows = (db.query(UserSession.id, UserSession.device, UserSession.browser, UserSession.os, UserSession.ip_address,
                     UserSession.last_active, UserSession.login_time, User.full_name)
            .join(User, User.id == UserSession.user_id)
            .filter(UserSession.is_active.is_(True), UserSession.revoked_at.is_(None))
            .order_by(UserSession.last_active.desc()).limit(limit).all())
    out = []
    for r in rows:
        model = " · ".join(x for x in [r.device, r.os, r.browser] if x) or "Unknown device"
        out.append({"id": r.id, "who": r.full_name, "model": model[:120], "ip": r.ip_address or "",
                    "last": (r.last_active or r.login_time).isoformat() if (r.last_active or r.login_time) else None})
    return out


def revoke_device(db: Session, user: User, session_id: int) -> None:
    row = db.query(UserSession).filter(UserSession.id == session_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")
    row.is_active = False
    row.revoked_at = now_ist()
    row.revoked_by_user_id = user.id
    row.revoke_reason = "Revoked from Settings → Mobile app"
    row.revoke_scope = "device"
    db.commit()


def billing(db: Session, master_db: Session, tenant: Optional[Tenant]) -> dict:
    if tenant is None:
        return {"plan": None, "seats": {"used": 0, "total": 0}, "usage": [], "invoices": [], "payment": None}
    plan = master_db.query(Plan).filter(Plan.id == tenant.plan_id).first() if tenant.plan_id else None
    seats_used = db.query(func.count(User.id)).filter(User.is_active.is_(True)).scalar() or 0
    seats_total = int(tenant.max_users or (plan.max_users if plan else 0) or 0)
    used_mb = float(tenant.used_storage or 0)
    limit_mb = int(tenant.storage_limit_mb or 0)
    invoices: list[dict] = []
    payment = None
    try:
        from app.services.platform_billing import PlatformInvoice
        from app.services.platform_invoicing import display_status
        rows = (master_db.query(PlatformInvoice).filter(PlatformInvoice.tenant_id == tenant.id)
                .order_by(PlatformInvoice.issued_on.desc(), PlatformInvoice.id.desc()).limit(6).all())
        for inv in rows:
            invoices.append({"id": inv.id, "n": inv.number,
                             "p": f"{inv.period_start:%b %Y}" if inv.period_start else "",
                             "a": float(inv.total or 0), "s": display_status(inv), "link": inv.payment_link or ""})
        paid = next((i for i in rows if i.paid_on), None)
        if paid:
            payment = {"method": (paid.gateway or "Bank transfer").title(), "ref": paid.payment_ref or "", "on": paid.paid_on.isoformat()}
    except Exception as exc:  # pragma: no cover – platform billing tables absent on a fresh master DB
        logger.info("Billing invoices unavailable: %s", exc)
    return {
        "plan": {"name": plan.name if plan else "Trial", "status": tenant.billing_status or tenant.status,
                 "renews": tenant.subscription_end_date.isoformat() if tenant.subscription_end_date else None,
                 "cycle": "annual" if plan and plan.price_yearly else "monthly"},
        "seats": {"used": int(seats_used), "total": seats_total},
        "usage": [
            {"n": "Storage", "u": round(used_mb / 1024, 2), "m": round(limit_mb / 1024, 2), "x": " GB"},
            {"n": "Users", "u": int(seats_used), "m": seats_total, "x": ""},
        ],
        "invoices": invoices,
        "payment": payment,
    }
