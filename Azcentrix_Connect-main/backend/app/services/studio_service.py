"""Customization Studio (prototype v17) – Layouts & fields · Picklists · Custom objects · Validation rules.

Layouts & fields: the effective layout of a module = prototype base (system) fields, overridden / extended by rows in
form_fields.  One SELECT per module; "Save layout" writes the whole layout in one transaction (upsert by field_key,
delete removed custom fields).  Nothing here changes how the module forms read form_fields today – those forms are
connected to the new properties (help text, master lookup, show-when) later.
Custom objects / records: records are JSON + a denormalised title (first field) for LIKE search and ORDER BY.
Validation rules: CRUD only; the evaluator is connected to the module endpoints later.
"""
from __future__ import annotations

import logging
import re
import threading
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import String, cast, func, inspect, or_, text
from sqlalchemy.orm import Session

from app.core.timezone import now_ist
from app.models.all_models import FormField, User
from app.models.studio import STUDIO_TABLES, CustomObject, CustomObjectField, CustomRecord, ValidationRule

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

# prototype FTYPES (+ 'master' inserted at position 10)
FTYPES = [("text", "Single line text"), ("textarea", "Multi-line text"), ("number", "Number"), ("currency", "Currency (₹)"), ("date", "Date"),
          ("select", "Dropdown"), ("multi", "Multi-select"), ("checkbox", "Checkbox"), ("user", "User lookup"), ("lookup", "Customer lookup"),
          ("master", "Master lookup"), ("email", "Email"), ("phone", "Phone"), ("file", "File upload"), ("formula", "Formula")]
FTYPE_KEYS = {k for k, _ in FTYPES}

# prototype FBK → this product's module keys (form_fields.module)
MODULES = [("customers", "Customers"), ("leads", "Leads"), ("opportunities", "Deals"), ("tenders", "Bids & Tenders"), ("quotations", "Quotes"),
           ("work_orders", "Orders & Projects"), ("emd", "Guarantees & Deposits"), ("travel", "Travel & Expense"), ("activities", "Activities"),
           ("oem", "Partners & OEM"), ("competitors", "Competitive Intel"), ("users", "Users"), ("docs", "Documents")]
MODULE_LABEL = dict(MODULES)

# Masters available for "Master lookup" fields (Directory → Masters endpoints)
MASTERS = [("lead-sources", "Lead sources"), ("products", "Products"), ("oems", "OEMs"), ("competitors", "Competitors"), ("regions", "Regions"),
           ("states", "States"), ("districts", "Districts"), ("vertical-sectors", "Vertical sectors"), ("vertical-sub-sectors", "Vertical sub-sectors"),
           ("lead-categories", "Lead categories"), ("lead-sub-categories", "Lead sub-categories"), ("business-categories", "Business categories"),
           ("business-units", "Business units"), ("groups", "Groups")]
MASTER_KEYS = {k for k, _ in MASTERS}
SHOW_WHEN = ["Always", "Opportunity type = Tender", "Opportunity type = Quotation", "Value ≥ ₹ 1 Cr", "Status = Active"]
RULE_OBJECTS = ["Deals", "Bids", "Quotes", "Accounts", "Leads", "Orders", "Guarantees"]


def _f(k: str, l: str, t: str = "text", req: int = 0, w: int = 1, o: Optional[list] = None, h: str = "") -> dict:
    return {"key": k, "label": l, "type": t, "req": bool(req), "w": w, "opts": o or [], "help": h}


# prototype FD – system fields per form
BASE_FIELDS: dict[str, list[dict]] = {
    "customers": [_f("name", "Customer name", "text", 1, 2), _f("type", "Customer type", "select", 1, 1, ["PSU", "Government", "Defence", "Private", "EPC Contractor"]),
                  _f("industry", "Industry", "select", 0, 1, ["Power", "Rail", "Defence", "Water", "Oil & Gas", "Infrastructure"]), _f("city", "City"),
                  _f("state", "State", "master", 0, 1), _f("kam", "Key account manager", "user"), _f("tier", "Tier", "select", 0, 1, ["A", "B", "C"]),
                  _f("gst", "GSTIN"), _f("email", "Email", "email"), _f("phone", "Phone", "phone"), _f("status", "Status", "select", 0, 1, ["Active", "Prospect", "Dormant"])],
    "leads": [_f("name", "Company", "text", 1, 2), _f("contact", "Contact person"), _f("source", "Source", "master"), _f("value", "Expected value", "currency"),
              _f("interest", "Interested in", "master"), _f("owner", "Owner", "user"), _f("next", "Next follow-up", "date")],
    "opportunities": [_f("name", "Opportunity name", "text", 1, 2), _f("customer", "Customer", "lookup", 1), _f("type", "Workflow type", "select", 1, 1, ["Tender", "Quotation"], "Decides which pipeline stages apply"),
                      _f("value", "Value", "currency"), _f("close", "Expected close", "date"), _f("owner", "Owner", "user"), _f("source", "Source", "master"), _f("emdReq", "EMD required", "checkbox")],
    "tenders": [_f("title", "Tender title", "text", 1, 2), _f("tenderNo", "Tender / NIT number", "text", 1), _f("customer", "Customer", "lookup", 1),
                _f("portal", "Portal", "select", 0, 1, ["GeM", "CPPP", "IREPS", "State portal", "Private"]), _f("value", "Estimated value", "currency"), _f("emd", "EMD amount", "currency"),
                _f("submit", "Bid submission date", "date", 1), _f("owner", "Bid manager", "user"), _f("category", "Category", "select", 0, 1, ["Supply", "EPC", "Services", "AMC"]), _f("location", "Location")],
    "quotations": [_f("subject", "Subject", "text", 1, 2), _f("customer", "Customer", "lookup", 1), _f("enquiry", "Enquiry reference"), _f("validTill", "Valid till", "date"), _f("owner", "Owner", "user")],
    "work_orders": [_f("title", "Work order title", "text", 1, 2), _f("customer", "Customer", "lookup", 1), _f("poNo", "PO number"), _f("value", "Order value", "currency"),
                    _f("start", "Start date", "date"), _f("end", "Due date", "date"), _f("pm", "Project manager", "user")],
    "emd": [_f("type", "Instrument", "select", 1, 1, ["EMD", "BG", "PBG", "Security Deposit", "FDR"]), _f("ref", "Reference / BG number", "text", 1), _f("bank", "Bank"),
            _f("amount", "Amount", "currency", 1), _f("validity", "Valid until", "date")],
    "travel": [_f("traveller", "Traveller", "user", 1), _f("purpose", "Purpose", "text", 1, 2), _f("from", "From"), _f("to", "To", "text", 1), _f("start", "Departure", "date"),
               _f("end", "Return", "date"), _f("mode", "Mode", "select", 0, 1, ["Flight", "Train", "Car"]), _f("cost", "Estimated cost", "currency")],
    "activities": [_f("type", "Activity type", "select", 1, 1, ["Site Visit", "Call", "Meeting", "Email", "Demo", "Follow-up"]), _f("customer", "Customer", "lookup", 1), _f("date", "Date", "date"),
                   _f("outcome", "Outcome", "select", 0, 1, ["Positive", "Neutral", "Follow-up needed"]), _f("note", "Notes", "textarea", 0, 2)],
    "oem": [_f("name", "OEM name", "text", 1), _f("category", "Category", "select", 0, 1, ["Switchgear", "Transformers", "Cables", "Automation", "Panels", "Batteries"]), _f("contact", "Contact"),
            _f("auth", "Authorisation valid till", "date"), _f("discount", "Typical discount %", "number")],
    "competitors": [_f("name", "Competitor", "text", 1), _f("hq", "Head office"), _f("strength", "Key strength"), _f("weak", "Key weakness")],
    "users": [_f("name", "Full name", "text", 1), _f("email", "Work email", "email", 1), _f("role", "Role", "select", 1), _f("dept", "Department"), _f("phone", "Phone", "phone")],
    "docs": [_f("name", "File name", "text", 1), _f("folder", "Folder", "select", 0, 1, ["Tender Documents", "Technical Bids", "Financial Bids", "Certificates", "Work Orders", "Letters", "OEM Authorisations"]), _f("tags", "Tags")],
}
BASE_MASTER = {("customers", "state"): "states", ("leads", "source"): "lead-sources", ("leads", "interest"): "products", ("opportunities", "source"): "lead-sources"}
STUDIO_SECTION = "studio"
_KEY_RE = re.compile(r"[^a-z0-9]+")


def slugify(s: str, prefix: str = "") -> str:
    k = _KEY_RE.sub("_", (s or "").strip().lower()).strip("_")[:50]
    return (prefix + k) if k else ""


# ─── schema ───────────────────────────────────────────────────────────────────

EXTRA_FORM_FIELD_COLUMNS = {"help_text": "VARCHAR(300) NULL", "master_key": "VARCHAR(100) NULL", "show_when": "VARCHAR(200) NULL"}


def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        FormField.__table__.create(bind=bind, checkfirst=True)
        for t in STUDIO_TABLES:
            t.create(bind=bind, checkfirst=True)
        cols = {c["name"] for c in inspect(bind).get_columns("form_fields")}
        for name, ddl in EXTRA_FORM_FIELD_COLUMNS.items():
            if name not in cols:
                db.execute(text(f"ALTER TABLE form_fields ADD COLUMN {name} {ddl}"))  # fixed identifiers, no user input
        db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant.slug).all()]
    except Exception as exc:  # pragma: no cover
        logger.warning("Studio schema sync: unable to list tenants: %s", exc)
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
            logger.warning("Studio schema sync failed for %s: %s", slug, exc)


def _extra(row: FormField, name: str):
    return getattr(row, name, None)


# ─── layouts & fields ─────────────────────────────────────────────────────────

def meta() -> dict:
    return {"modules": [{"k": k, "l": l} for k, l in MODULES], "types": [{"k": k, "l": l} for k, l in FTYPES],
            "masters": [{"k": k, "l": l} for k, l in MASTERS], "show_when": SHOW_WHEN}


def layout(db: Session, module: str) -> dict:
    if module not in MODULE_LABEL:
        raise HTTPException(404, "Unknown form")
    base = BASE_FIELDS.get(module, [])
    rows = db.query(FormField).filter(FormField.module == module).all()   # one query – overrides + custom fields
    by_key = {r.field_key: r for r in rows}
    out: list[dict] = []
    for i, b in enumerate(base):
        r = by_key.get(b["key"])
        f = {"id": r.id if r else None, "key": b["key"], "label": (r.label if r else b["label"]), "type": b["type"], "sys": True,
             "req": bool(r.is_required) if r else b["req"], "w": (2 if (r.col_span or 1) >= 2 else 1) if r else b["w"],
             "opts": (r.options if (r and isinstance(r.options, list) and r.options) else b["opts"]),
             "help": (_extra(r, "help_text") if r else None) or b["help"], "visible": bool(r.is_visible) if r else True,
             "master": (_extra(r, "master_key") if r else None) or BASE_MASTER.get((module, b["key"])),
             "show_when": (_extra(r, "show_when") if r else None) or "Always", "sort": (r.sort_order if r else i)}
        out.append(f)
    for r in rows:
        if r.field_key in {b["key"] for b in base} or not r.is_custom:
            continue
        out.append({"id": r.id, "key": r.field_key, "label": r.label, "type": r.field_type if r.field_type in FTYPE_KEYS else "text", "sys": False,
                    "req": bool(r.is_required), "w": 2 if (r.col_span or 1) >= 2 else 1, "opts": r.options if isinstance(r.options, list) else [],
                    "help": _extra(r, "help_text") or "", "visible": bool(r.is_visible), "master": _extra(r, "master_key") or None,
                    "show_when": _extra(r, "show_when") or "Always", "sort": r.sort_order})
    out.sort(key=lambda f: (f["sort"], 0 if f["sys"] else 1))
    for i, f in enumerate(out):
        f["sort"] = i
    return {"module": module, "label": MODULE_LABEL[module], "fields": out}


def _clean_field(f: dict, sys_keys: set[str]) -> dict:
    key = str(f.get("key") or "").strip()
    label = str(f.get("label") or "").strip()[:200]
    typ = str(f.get("type") or "text")
    if not label:
        raise HTTPException(422, "Every field needs a label")
    if key in sys_keys:
        typ = None  # system field type is fixed
    elif typ not in FTYPE_KEYS:
        raise HTTPException(422, f"Unknown field type for {label}")
    if not key:
        key = slugify(label, "cf_")
    if not key or len(key) > 100 or (key not in sys_keys and not key.startswith("cf_")):
        key = "cf_" + slugify(label)
    opts = [str(o).strip()[:120] for o in (f.get("opts") or []) if str(o).strip()][:200]
    master = str(f.get("master") or "").strip() or None
    if master and master not in MASTER_KEYS:
        raise HTTPException(422, f"Unknown master list for {label}")
    show_when = str(f.get("show_when") or "Always").strip()[:200]
    return {"key": key, "label": label, "type": typ, "req": bool(f.get("req")), "w": 2 if int(f.get("w") or 1) >= 2 else 1, "opts": opts,
            "help": str(f.get("help") or "").strip()[:300], "visible": bool(f.get("visible", True)), "master": master, "show_when": show_when}


def save_layout(db: Session, cu: User, module: str, fields: list[dict]) -> dict:
    """Prototype "Save layout": the whole ordered layout in one transaction (no per-field round-trips)."""
    if module not in MODULE_LABEL:
        raise HTTPException(404, "Unknown form")
    if len(fields) > 200:
        raise HTTPException(422, "A form can hold at most 200 fields")
    base = {b["key"]: b for b in BASE_FIELDS.get(module, [])}
    cleaned = [_clean_field(f, set(base)) for f in fields]
    keys = [c["key"] for c in cleaned]
    if len(set(keys)) != len(keys):
        raise HTTPException(422, "Field keys must be unique")
    existing = {r.field_key: r for r in db.query(FormField).filter(FormField.module == module).all()}
    kept: set[str] = set()
    for i, c in enumerate(cleaned):
        b = base.get(c["key"])
        r = existing.get(c["key"])
        is_sys = b is not None
        if is_sys and r is None:
            unchanged = (c["label"] == b["label"] and c["req"] == b["req"] and c["w"] == b["w"] and c["visible"] and not c["help"] and c["show_when"] == "Always"
                         and (c["master"] or None) == BASE_MASTER.get((module, c["key"])) and (c["opts"] == b["opts"] or not c["opts"]) and i == list(base).index(c["key"]))
            if unchanged:
                continue  # still default – no override row needed
            r = FormField(module=module, section=STUDIO_SECTION, field_key=c["key"], is_custom=False)
            db.add(r)
        elif r is None:
            r = FormField(module=module, section=STUDIO_SECTION, field_key=c["key"], is_custom=True)
            db.add(r)
        r.label = c["label"]
        r.field_type = (b["type"] if is_sys else c["type"]) or "text"
        r.options = c["opts"] or None
        r.col_span = c["w"]
        r.is_required = c["req"]
        r.is_visible = c["visible"]
        r.sort_order = i
        if hasattr(r, "help_text"):
            r.help_text = c["help"] or None
            r.master_key = c["master"] if (c["type"] == "master" or (is_sys and b["type"] == "master")) else None
            r.show_when = None if c["show_when"] == "Always" else c["show_when"]
        kept.add(c["key"])
    for key, r in existing.items():
        if key not in kept and (r.is_custom or key in base):
            db.delete(r)  # custom field removed, or system override reverted to default
    db.commit()
    return layout(db, module)


# ─── picklists ────────────────────────────────────────────────────────────────

def picklists(db: Session) -> dict:
    """Masters used in forms (form_fields.master_key + base master fields), grouped by master."""
    used: dict[str, list[dict]] = {}
    for (module, key), m in BASE_MASTER.items():
        lab = next((b["label"] for b in BASE_FIELDS[module] if b["key"] == key), key)
        used.setdefault(m, []).append({"module": MODULE_LABEL.get(module, module), "field": lab})
    if hasattr(FormField, "master_key"):
        rows = db.query(FormField.module, FormField.label, FormField.master_key).filter(FormField.master_key.isnot(None)).all()
        for module, label, m in rows:
            lst = used.setdefault(m, [])
            if not any(x["module"] == MODULE_LABEL.get(module, module) and x["field"] == label for x in lst):
                lst.append({"module": MODULE_LABEL.get(module, module), "field": label})
    labels = dict(MASTERS)
    return {"masters": [{"k": k, "l": l} for k, l in MASTERS],
            "used": [{"k": k, "l": labels.get(k, k), "u": v} for k, v in used.items() if k in labels]}


# ─── custom objects ───────────────────────────────────────────────────────────

CO_TYPES = {"text", "textarea", "number", "currency", "date", "select", "checkbox", "user", "email", "phone"}


def _obj_dict(o: CustomObject, fields: list[CustomObjectField], n: int) -> dict:
    return {"id": o.id, "slug": o.slug, "n": o.name, "p": o.plural, "icon": o.icon, "rows": n,
            "f": [{"id": f.id, "k": f.key, "l": f.label, "t": f.field_type, "o": f.options or [], "req": bool(f.is_required)} for f in sorted(fields, key=lambda x: (x.sort_order, x.id))]}


def objects(db: Session) -> list[dict]:
    objs = db.query(CustomObject).filter(CustomObject.is_active.is_(True)).order_by(CustomObject.name).all()
    if not objs:
        return []
    ids = [o.id for o in objs]
    fields: dict[int, list[CustomObjectField]] = {}
    for f in db.query(CustomObjectField).filter(CustomObjectField.object_id.in_(ids)).all():
        fields.setdefault(f.object_id, []).append(f)
    counts = dict(db.query(CustomRecord.object_id, func.count(CustomRecord.id)).filter(CustomRecord.object_id.in_(ids)).group_by(CustomRecord.object_id).all())
    return [_obj_dict(o, fields.get(o.id, []), int(counts.get(o.id, 0))) for o in objs]


def get_object(db: Session, object_id: int) -> tuple[CustomObject, list[CustomObjectField]]:
    o = db.query(CustomObject).filter(CustomObject.id == object_id, CustomObject.is_active.is_(True)).first()
    if not o:
        raise HTTPException(404, "Custom object not found")
    fields = db.query(CustomObjectField).filter(CustomObjectField.object_id == o.id).order_by(CustomObjectField.sort_order, CustomObjectField.id).all()
    return o, fields


def create_object(db: Session, cu: User, name: str, plural: str, fields: list[dict]) -> dict:
    name = (name or "").strip()[:100]
    if not name:
        raise HTTPException(422, "Name the object")
    plural = (plural or "").strip()[:100] or name + "s"
    slug = slugify(name)
    if not slug:
        raise HTTPException(422, "Name must contain letters or numbers")
    if db.query(CustomObject.id).filter(CustomObject.slug == slug).first():
        raise HTTPException(409, "An object with this name already exists")
    if not fields:
        raise HTTPException(422, "Add at least one field")
    if len(fields) > 60:
        raise HTTPException(422, "At most 60 fields per object")
    o = CustomObject(slug=slug, name=name, plural=plural, created_by=cu.id)
    db.add(o)
    db.flush()
    seen: set[str] = set()
    for i, f in enumerate(fields):
        label = str(f.get("l") or f.get("label") or "").strip()[:120]
        if not label:
            continue
        key = slugify(label)
        if not key or key in seen:
            key = f"{key or 'field'}_{i}"
        seen.add(key)
        typ = str(f.get("t") or f.get("type") or "text")
        if typ not in CO_TYPES:
            typ = "text"
        opts = [str(x).strip()[:120] for x in (f.get("o") or f.get("opts") or []) if str(x).strip()][:100]
        db.add(CustomObjectField(object_id=o.id, key=key, label=label, field_type=typ, options=opts or None, is_required=bool(f.get("req")), sort_order=i))
    db.commit()
    o2, fl = get_object(db, o.id)
    return _obj_dict(o2, fl, 0)


def delete_object(db: Session, object_id: int) -> None:
    o, _ = get_object(db, object_id)
    o.is_active = False
    db.commit()


def _record_dict(r: CustomRecord, fields: list[CustomObjectField]) -> dict:
    d = r.data if isinstance(r.data, dict) else {}
    out = {"id": r.id, "created": r.created_at.isoformat() if r.created_at else None, "updated": r.updated_at.isoformat() if r.updated_at else None}
    for f in fields:
        out[f.key] = d.get(f.key, "")
    return out


def records(db: Session, object_id: int, *, q: str, sorts: list, offset: int, limit: int) -> dict:
    o, fields = get_object(db, object_id)
    base = db.query(CustomRecord).filter(CustomRecord.object_id == o.id)
    if q:
        like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        base = base.filter(or_(CustomRecord.title.ilike(like), cast(CustomRecord.data, String).ilike(like)))
    total = base.with_entities(func.count(CustomRecord.id)).scalar() or 0
    order = []
    for s in sorts or []:
        if isinstance(s, (list, tuple)) and len(s) == 2:
            col = {"created": CustomRecord.created_at, "updated": CustomRecord.updated_at, "id": CustomRecord.id}.get(str(s[0]))
            if col is None and fields and str(s[0]) == fields[0].key:
                col = CustomRecord.title
            if col is not None:
                order.append(col.desc() if int(s[1]) < 0 else col.asc())
    rows = base.order_by(*(order or [CustomRecord.created_at.desc(), CustomRecord.id.desc()])).offset(max(0, offset)).limit(max(1, min(limit, 250))).all()
    return {"object": _obj_dict(o, fields, int(total)), "items": [_record_dict(r, fields) for r in rows], "total": int(total)}


def _clean_record(fields: list[CustomObjectField], data: dict) -> tuple[dict, str]:
    out: dict[str, Any] = {}
    for f in fields:
        v = data.get(f.key)
        if f.field_type == "checkbox":
            out[f.key] = bool(v)
            continue
        if v is None or v == "":
            if f.is_required:
                raise HTTPException(422, f"{f.label} is required")
            out[f.key] = ""
            continue
        if f.field_type in ("number", "currency"):
            try:
                n = float(v)
            except (TypeError, ValueError):
                raise HTTPException(422, f"{f.label} must be a number")
            out[f.key] = int(n) if n.is_integer() else n
        elif f.field_type == "select" and f.options and str(v) not in [str(x) for x in f.options]:
            raise HTTPException(422, f"{f.label}: choose one of the listed options")
        else:
            out[f.key] = str(v)[:2000]
    title = str(out.get(fields[0].key, "") if fields else "")[:300]
    return out, title


def save_record(db: Session, cu: User, object_id: int, data: dict, record_id: Optional[int] = None) -> dict:
    o, fields = get_object(db, object_id)
    clean, title = _clean_record(fields, data or {})
    if record_id:
        r = db.query(CustomRecord).filter(CustomRecord.id == record_id, CustomRecord.object_id == o.id).first()
        if not r:
            raise HTTPException(404, "Record not found")
        r.data, r.title, r.updated_at = clean, title, now_ist()
    else:
        r = CustomRecord(object_id=o.id, data=clean, title=title, created_by=cu.id)
        db.add(r)
    db.commit()
    return _record_dict(r, fields)


def delete_record(db: Session, object_id: int, record_id: int) -> None:
    n = db.query(CustomRecord).filter(CustomRecord.id == record_id, CustomRecord.object_id == object_id).delete(synchronize_session=False)
    if not n:
        raise HTTPException(404, "Record not found")
    db.commit()


# ─── validation rules ─────────────────────────────────────────────────────────

def _rule_dict(r: ValidationRule) -> dict:
    return {"id": r.id, "n": r.name, "o": r.object, "f": r.formula, "m": r.message, "on": bool(r.is_active)}


def rules(db: Session) -> dict:
    rows = db.query(ValidationRule).order_by(ValidationRule.sort_order, ValidationRule.id).all()
    return {"items": [_rule_dict(r) for r in rows], "objects": RULE_OBJECTS}


def save_rule(db: Session, cu: User, data: dict, rule_id: Optional[int] = None) -> dict:
    name = str(data.get("name") or "").strip()[:160] or "Untitled rule"
    obj = str(data.get("object") or "").strip()
    formula = str(data.get("formula") or "").strip()[:300]
    message = str(data.get("message") or "").strip()[:300]
    if obj not in RULE_OBJECTS:
        raise HTTPException(422, "Choose an object")
    if not formula:
        raise HTTPException(422, "Enter the formula")
    if not message:
        raise HTTPException(422, "Enter the error message shown to users")
    if rule_id:
        r = db.query(ValidationRule).filter(ValidationRule.id == rule_id).first()
        if not r:
            raise HTTPException(404, "Rule not found")
    else:
        r = ValidationRule(created_by=cu.id, sort_order=(db.query(func.coalesce(func.max(ValidationRule.sort_order), 0)).scalar() or 0) + 1)
        db.add(r)
    r.name, r.object, r.formula, r.message = name, obj, formula, message
    if "on" in data:
        r.is_active = bool(data.get("on"))
    db.commit()
    return _rule_dict(r)


def toggle_rule(db: Session, rule_id: int, on: bool) -> dict:
    r = db.query(ValidationRule).filter(ValidationRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Rule not found")
    r.is_active = bool(on)
    db.commit()
    return _rule_dict(r)


def delete_rule(db: Session, rule_id: int) -> None:
    n = db.query(ValidationRule).filter(ValidationRule.id == rule_id).delete(synchronize_session=False)
    if not n:
        raise HTTPException(404, "Rule not found")
    db.commit()
