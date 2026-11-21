"""Masters (prototype v17 R.masters) – one registry for the standard masters (their own tables) and the custom ones
(master_defs / master_values), with parent › child links for both.

Every screen is a bounded set of queries:
  tree     one COUNT per standard table + one grouped COUNT over master_values + one SELECT of form_fields using masters
  master   one paginated SELECT of values, the parent master's values (one SELECT, used to label every row – no per-row
           lookup), and one grouped COUNT per usage column restricted to the page's ids ("Used")
All filtering uses bound parameters; sorting is by the table's own order column or the value.
"""
from __future__ import annotations

import logging
import re
import threading
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.all_models import (OEM, BusinessCategory, BusinessUnit, Customer, FormField, Lead, LeadCategory, LeadProduct, LeadSource, LeadSubCategory,
                                   ProductMaster, Tender, TenderProduct, User, VerticalSector, VerticalSubSector)
from app.models.masters360 import MASTERS360_TABLES, MasterDef, MasterValue

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

KINDS = {"Simple list": [], "List with code & description": ["Code", "Description"], "Hierarchy (parent › child)": ["Code", "Parent"]}
MODULES = [("customers", "Customers"), ("leads", "Leads"), ("opportunities", "Deals"), ("tenders", "Bids & Tenders"), ("quotations", "Quotes"), ("work_orders", "Orders & Projects")]
_SLUG = re.compile(r"[^a-z0-9]+")

# Standard masters: table, value column, extra attribute columns (label → column), order / active columns, parent (master key, FK column),
# where the standard field lives (prototype STDUSE) and the record columns that reference a value ("Used").
STD: dict[str, dict[str, Any]] = {
    "lead-sources": {"name": "Lead sources", "model": LeadSource, "attrs": [("Description", "description")], "use": "Leads · Bids & Tenders",
                     "usage": [(Lead, "source_id"), (Tender, "source_id")]},
    "lead-categories": {"name": "Lead categories", "model": LeadCategory, "attrs": [("Description", "description")], "use": "Leads"},
    "lead-sub-categories": {"name": "Lead sub categories", "model": LeadSubCategory, "attrs": [("Description", "description")], "parent": ("lead-categories", "category_id"), "use": "Leads"},
    "vertical-sectors": {"name": "Customer segments", "model": VerticalSector, "attrs": [("Description", "description")], "order": "display_order", "use": "Customers",
                         "usage_name": [(Customer, "customer_vertical")]},
    "vertical-sub-sectors": {"name": "Customer sub segments", "model": VerticalSubSector, "attrs": [], "parent": ("vertical-sectors", "sector_id"), "use": "Customers"},
    "business-categories": {"name": "Business categories", "model": BusinessCategory, "attrs": [], "order": "display_order", "use": "Leads · Bids & Tenders"},
    "business-units": {"name": "Business verticals", "model": BusinessUnit, "attrs": [], "parent": ("business-categories", "category_id"), "use": "Leads · Bids & Tenders",
                       "usage": [(Lead, "business_vertical_id"), (Tender, "business_vertical_id")]},
    "products": {"name": "Products", "model": ProductMaster, "attrs": [("Category", "category"), ("Description", "description")], "use": "Leads · Bids & Tenders · Partners & OEM",
                 "usage": [(LeadProduct, "product_id"), (TenderProduct, "product_id"), (OEM, "product_id")]},
}
# Screens that are not value lists (kept as they are, opened inside the page)
SCREENS = [("locations", "Locations"), ("group-fixing", "Groups"), ("questionnaire", "Questionnaire")]
STUDIO_SECTION = "studio"


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        for t in MASTERS360_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant.slug).all()]
    except Exception as exc:  # pragma: no cover
        logger.warning("Masters schema sync: unable to list tenants: %s", exc)
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
            logger.warning("Masters schema sync failed for %s: %s", slug, exc)


# ─── definitions ──────────────────────────────────────────────────────────────

def _like(s: str) -> str:
    return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _kind(std: dict) -> str:
    if std.get("parent"):
        return "Hierarchy (parent › child)"
    return "List with code & description" if std.get("attrs") else "Simple list"


def _defs(db: Session) -> dict[str, dict]:
    """Every master (standard + custom) as a uniform definition."""
    out: dict[str, dict] = {}
    for k, s in STD.items():
        out[k] = {"key": k, "name": s["name"], "std": True, "kind": _kind(s), "parent_key": s["parent"][0] if s.get("parent") else None,
                  "attrs": [a for a, _ in s["attrs"]], "desc": "Used in " + s["use"], "use": s["use"], "order": bool(s.get("order"))}
    for d in db.query(MasterDef).filter(MasterDef.is_active.is_(True)).order_by(MasterDef.id).all():
        attrs = [a for a in KINDS.get(d.kind, []) if a != "Parent"]
        out[d.key] = {"key": d.key, "name": d.name, "std": False, "kind": d.kind, "parent_key": d.parent_key if d.kind == "Hierarchy (parent › child)" else None,
                      "attrs": attrs, "desc": d.description or "Custom master", "use": "", "order": True, "id": d.id}
    return out


def _form_usage(db: Session, key: Optional[str] = None) -> dict[str, list[dict]]:
    q = db.query(FormField.module, FormField.label, FormField.master_key).filter(FormField.master_key.isnot(None), FormField.is_visible.is_(True))
    if key:
        q = q.filter(FormField.master_key == key)
    out: dict[str, list[dict]] = {}
    labels = dict(MODULES)
    for m, l, mk in q.all():
        out.setdefault(mk, []).append({"k": m, "m": labels.get(m, m), "f": l})
    return out


def tree(db: Session, company: str) -> dict:
    defs = _defs(db)
    counts: dict[str, int] = {}
    for k, s in STD.items():
        M = s["model"]
        counts[k] = int(db.query(func.count(M.id)).scalar() or 0)
    custom_ids = {d["id"]: d["key"] for d in defs.values() if not d["std"]}
    if custom_ids:
        for mid, n in db.query(MasterValue.master_id, func.count(MasterValue.id)).filter(MasterValue.master_id.in_(list(custom_ids))).group_by(MasterValue.master_id).all():
            counts[custom_ids[mid]] = int(n)
    used = _form_usage(db)
    items = []
    for d in defs.values():
        items.append({"key": d["key"], "name": d["name"], "std": d["std"], "kind": d["kind"], "parent_key": d["parent_key"], "n": counts.get(d["key"], 0),
                      "forms": len(used.get(d["key"], []))})
    return {"company": company, "masters": items, "screens": [{"key": k, "name": n} for k, n in SCREENS], "kinds": list(KINDS.keys()),
            "modules": [{"k": k, "l": l} for k, l in MODULES], "custom": sum(1 for d in defs.values() if not d["std"])}


# ─── value access (standard tables and custom values share one shape) ─────────

def _std_cols(key: str) -> dict:
    s = STD[key]
    M = s["model"]
    return {"M": M, "value": M.name, "active": getattr(M, "is_active", None), "order": getattr(M, s["order"]) if s.get("order") else None,
            "parent": getattr(M, s["parent"][1]) if s.get("parent") else None, "attrs": {a: getattr(M, c) for a, c in s["attrs"]}}


def _all_values(db: Session, key: str, defs: dict) -> list[tuple[int, str]]:
    """(id, value) of every active value of a master – used to label / pick parents (bounded: masters are small)."""
    d = defs.get(key)
    if d is None:
        return []
    if d["std"]:
        c = _std_cols(key)
        q = db.query(c["M"].id, c["value"])
        if c["active"] is not None:
            q = q.filter(or_(c["active"].is_(True), c["active"].is_(None)))
        return [(i, v) for i, v in q.order_by(*( [c["order"]] if c["order"] is not None else []), c["value"]).limit(5000).all()]
    return [(v.id, v.value) for v in db.query(MasterValue.id, MasterValue.value).filter(MasterValue.master_id == d["id"], MasterValue.is_active.is_(True))
            .order_by(MasterValue.position, MasterValue.value).limit(5000).all()]


def _usage_counts(db: Session, key: str, ids: list[int], values: list[str]) -> dict[int, int]:
    s = STD.get(key) or {}
    out: dict[int, int] = {}
    if ids:
        for M, col in s.get("usage", []):
            c = getattr(M, col)
            for v, n in db.query(c, func.count()).filter(c.in_(ids)).group_by(c).all():
                out[int(v)] = out.get(int(v), 0) + int(n)
    if values and s.get("usage_name"):
        by_val = {}
        for M, col in s["usage_name"]:
            c = getattr(M, col)
            for v, n in db.query(c, func.count()).filter(c.in_(values)).group_by(c).all():
                by_val[str(v)] = by_val.get(str(v), 0) + int(n)
        return {"_by_value": by_val, **out}  # type: ignore[return-value]
    return out


def master(db: Session, key: str, *, q: str, offset: int, limit: int) -> dict:
    defs = _defs(db)
    d = defs.get(key)
    if d is None:
        raise HTTPException(404, "Master not found")
    parents = _all_values(db, d["parent_key"], defs) if d["parent_key"] else []
    pname = dict(parents)
    items: list[dict] = []
    if d["std"]:
        c = _std_cols(key)
        base = db.query(c["M"])
        if q:
            base = base.filter(c["value"].ilike(_like(q)))
        total = base.with_entities(func.count(c["M"].id)).scalar() or 0
        order = ([c["order"]] if c["order"] is not None else []) + [c["value"]]
        rows = base.order_by(*order).offset(offset).limit(limit).all()
        for i, r in enumerate(rows):
            attrs = {a: getattr(r, col) or "" for a, col in STD[key]["attrs"]}
            pid = getattr(r, STD[key]["parent"][1]) if STD[key].get("parent") else None
            items.append({"id": r.id, "v": r.name, "attrs": attrs, "parent_id": pid, "parent": pname.get(pid, "") if pid else "",
                          "on": bool(getattr(r, "is_active", True)) if getattr(r, "is_active", None) is not None else True, "pos": offset + i})
    else:
        base = db.query(MasterValue).filter(MasterValue.master_id == d["id"])
        if q:
            base = base.filter(MasterValue.value.ilike(_like(q)))
        total = base.with_entities(func.count(MasterValue.id)).scalar() or 0
        rows = base.order_by(MasterValue.position, MasterValue.id).offset(offset).limit(limit).all()
        for i, r in enumerate(rows):
            attrs = {}
            if "Code" in d["attrs"]:
                attrs["Code"] = r.code or ""
            if "Description" in d["attrs"]:
                attrs["Description"] = r.description or ""
            items.append({"id": r.id, "v": r.value, "attrs": attrs, "parent_id": r.parent_ref, "parent": pname.get(r.parent_ref, "") if r.parent_ref else "",
                          "on": bool(r.is_active), "pos": offset + i})
    used = _usage_counts(db, key, [x["id"] for x in items], [x["v"] for x in items]) if d["std"] else {}
    by_val = used.pop("_by_value", {}) if isinstance(used, dict) else {}
    for x in items:
        x["used"] = int(used.get(x["id"], 0)) + int(by_val.get(x["v"], 0))
    forms = _form_usage(db, key).get(key, [])
    return {"def": d, "items": items, "total": int(total), "parents": [{"id": i, "v": v} for i, v in parents], "forms": forms, "offset": offset, "limit": limit}


# ─── writes ───────────────────────────────────────────────────────────────────

def _clean_value(v) -> str:
    v = str(v or "").strip()[:200]
    if not v:
        raise HTTPException(422, "Enter a value")
    return v


def _custom_def(db: Session, key: str) -> MasterDef:
    d = db.query(MasterDef).filter(MasterDef.key == key, MasterDef.is_active.is_(True)).first()
    if d is None:
        raise HTTPException(404, "Master not found")
    return d


def _check_parent(db: Session, defs: dict, d: dict, parent_id) -> Optional[int]:
    if not d["parent_key"]:
        return None
    if parent_id in (None, "", 0):
        raise HTTPException(422, f"Choose the parent ({defs[d['parent_key']]['name']}) for this value")
    pid = int(parent_id)
    if pid not in {i for i, _ in _all_values(db, d["parent_key"], defs)}:
        raise HTTPException(422, "Unknown parent value")
    return pid


def add_value(db: Session, key: str, value: str, attrs: dict, parent_id) -> int:
    defs = _defs(db)
    d = defs.get(key)
    if d is None:
        raise HTTPException(404, "Master not found")
    v = _clean_value(value)
    pid = _check_parent(db, defs, d, parent_id)
    attrs = {k: str(x or "").strip()[:300] for k, x in (attrs or {}).items()}
    if d["std"]:
        c = _std_cols(key)
        dup = db.query(c["M"].id).filter(func.lower(c["value"]) == v.lower())
        if c["parent"] is not None:
            dup = dup.filter(c["parent"] == pid)
        if dup.first():
            raise HTTPException(409, "This value already exists")
        row = c["M"](name=v)
        for a, col in STD[key]["attrs"]:
            if a in attrs:
                setattr(row, col, attrs[a] or None)
        if c["parent"] is not None:
            setattr(row, STD[key]["parent"][1], pid)
        if c["order"] is not None:
            setattr(row, STD[key]["order"], (db.query(func.coalesce(func.max(c["order"]), 0)).scalar() or 0) + 1)
        if c["active"] is not None:
            row.is_active = True
        db.add(row)
        db.commit()
        return row.id
    md = _custom_def(db, key)
    if db.query(MasterValue.id).filter(MasterValue.master_id == md.id, func.lower(MasterValue.value) == v.lower()).first():
        raise HTTPException(409, "This value already exists")
    pos = (db.query(func.coalesce(func.max(MasterValue.position), 0)).filter(MasterValue.master_id == md.id).scalar() or 0) + 1
    row = MasterValue(master_id=md.id, value=v, code=attrs.get("Code") or None, description=attrs.get("Description") or None, parent_ref=pid, position=pos, is_active=True)
    db.add(row)
    db.commit()
    return row.id


def update_value(db: Session, key: str, vid: int, patch: dict) -> None:
    defs = _defs(db)
    d = defs.get(key)
    if d is None:
        raise HTTPException(404, "Master not found")
    if d["std"]:
        c = _std_cols(key)
        row = db.get(c["M"], vid)
        if row is None:
            raise HTTPException(404, "Value not found")
        if "v" in patch:
            v = _clean_value(patch["v"])
            dup = db.query(c["M"].id).filter(func.lower(c["value"]) == v.lower(), c["M"].id != vid)
            if c["parent"] is not None:
                dup = dup.filter(c["parent"] == getattr(row, STD[key]["parent"][1]))
            if dup.first():
                raise HTTPException(409, "This value already exists")
            row.name = v
        for a, col in STD[key]["attrs"]:
            if a in (patch.get("attrs") or {}):
                setattr(row, col, str(patch["attrs"][a] or "").strip()[:300] or None)
        if "parent_id" in patch and c["parent"] is not None:
            setattr(row, STD[key]["parent"][1], _check_parent(db, defs, d, patch["parent_id"]))
        if "on" in patch and c["active"] is not None:
            row.is_active = bool(patch["on"])
        db.commit()
        return
    md = _custom_def(db, key)
    row = db.query(MasterValue).filter(MasterValue.id == vid, MasterValue.master_id == md.id).first()
    if row is None:
        raise HTTPException(404, "Value not found")
    if "v" in patch:
        v = _clean_value(patch["v"])
        if db.query(MasterValue.id).filter(MasterValue.master_id == md.id, func.lower(MasterValue.value) == v.lower(), MasterValue.id != vid).first():
            raise HTTPException(409, "This value already exists")
        row.value = v
    at = patch.get("attrs") or {}
    if "Code" in at:
        row.code = str(at["Code"] or "").strip()[:60] or None
    if "Description" in at:
        row.description = str(at["Description"] or "").strip()[:300] or None
    if "parent_id" in patch:
        row.parent_ref = _check_parent(db, defs, d, patch["parent_id"])
    if "on" in patch:
        row.is_active = bool(patch["on"])
    db.commit()


def _children_of(db: Session, defs: dict, key: str, vid: int) -> int:
    """Values of child masters that point at this value (one COUNT per child master)."""
    n = 0
    for ck, cd in defs.items():
        if cd["parent_key"] != key:
            continue
        if cd["std"]:
            c = _std_cols(ck)
            n += int(db.query(func.count(c["M"].id)).filter(c["parent"] == vid).scalar() or 0)
        else:
            n += int(db.query(func.count(MasterValue.id)).filter(MasterValue.master_id == cd["id"], MasterValue.parent_ref == vid).scalar() or 0)
    return n


def delete_value(db: Session, key: str, vid: int) -> None:
    defs = _defs(db)
    d = defs.get(key)
    if d is None:
        raise HTTPException(404, "Master not found")
    kids = _children_of(db, defs, key, vid)
    if kids:
        raise HTTPException(409, f"{kids} child value(s) depend on it – switch it off instead, or remove them first")
    if d["std"]:
        c = _std_cols(key)
        row = db.get(c["M"], vid)
        if row is None:
            raise HTTPException(404, "Value not found")
        used = _usage_counts(db, key, [vid], [row.name])
        by_val = used.pop("_by_value", {}) if isinstance(used, dict) else {}
        if used.get(vid, 0) or by_val.get(row.name, 0):
            raise HTTPException(409, "This value is used by records – switch it off instead of removing it")
        db.delete(row)
    else:
        md = _custom_def(db, key)
        n = db.query(MasterValue).filter(MasterValue.id == vid, MasterValue.master_id == md.id).delete(synchronize_session=False)
        if not n:
            raise HTTPException(404, "Value not found")
    db.commit()


def move_value(db: Session, key: str, vid: int, direction: int) -> None:
    defs = _defs(db)
    d = defs.get(key)
    if d is None:
        raise HTTPException(404, "Master not found")
    if not d["order"]:
        raise HTTPException(422, "This master is sorted alphabetically and cannot be reordered")
    if d["std"]:
        c = _std_cols(key)
        rows = db.query(c["M"]).order_by(c["order"], c["value"]).all()
        col = STD[key]["order"]
    else:
        md = _custom_def(db, key)
        rows = db.query(MasterValue).filter(MasterValue.master_id == md.id).order_by(MasterValue.position, MasterValue.id).all()
        col = "position"
    i = next((n for n, r in enumerate(rows) if r.id == vid), -1)
    j = i + (1 if direction > 0 else -1)
    if i < 0 or j < 0 or j >= len(rows):
        return
    rows[i], rows[j] = rows[j], rows[i]
    for n, r in enumerate(rows):     # renumber once – keeps positions dense (bounded: a master is a short list)
        if getattr(r, col) != n + 1:
            setattr(r, col, n + 1)
    db.commit()


def import_values(db: Session, key: str, values: list[str], parent_id) -> int:
    defs = _defs(db)
    d = defs.get(key)
    if d is None:
        raise HTTPException(404, "Master not found")
    existing = {v.lower() for _, v in _all_values(db, key, defs)}
    added = 0
    for raw in values[:2000]:
        v = str(raw or "").strip()[:200]
        if not v or v.lower() in existing:
            continue
        try:
            add_value(db, key, v, {}, parent_id)
            existing.add(v.lower())
            added += 1
        except HTTPException:
            db.rollback()
    return added


# ─── masters themselves ───────────────────────────────────────────────────────

def create_master(db: Session, cu: User, name: str, description: str, kind: str, parent_key: Optional[str], values: list[str], add_to: Optional[str]) -> str:
    name = (name or "").strip()[:100]
    if not name:
        raise HTTPException(422, "Name the master")
    if kind not in KINDS:
        raise HTTPException(422, "Unknown master type")
    defs = _defs(db)
    if any(d["name"].lower() == name.lower() for d in defs.values()):
        raise HTTPException(409, "A master with this name exists")
    if kind == "Hierarchy (parent › child)":
        if not parent_key or parent_key not in defs:
            raise HTTPException(422, "Choose the parent master for a hierarchy master")
    else:
        parent_key = None
    base = "cm_" + (_SLUG.sub("_", name.lower()).strip("_")[:50] or "master")
    key, n = base, 1
    taken = {k for (k,) in db.query(MasterDef.key).all()}
    while key in taken:
        n += 1
        key = f"{base}_{n}"
    md = MasterDef(key=key, name=name, description=(description or "").strip()[:300] or None, kind=kind, parent_key=parent_key, is_active=True, created_by=cu.id)
    db.add(md)
    db.flush()
    vals = [str(v).strip()[:200] for v in values if str(v).strip()]
    seen: set[str] = set()
    pos = 0
    for v in vals:
        if v.lower() in seen:
            continue
        seen.add(v.lower())
        pos += 1
        db.add(MasterValue(master_id=md.id, value=v, position=pos, is_active=True))
    db.commit()
    if add_to:
        add_to_form(db, key, add_to, name)
    return key


def rename_master(db: Session, key: str, name: str, description: Optional[str]) -> None:
    md = _custom_def(db, key)
    name = (name or "").strip()[:100]
    if not name:
        raise HTTPException(422, "Name the master")
    defs = _defs(db)
    if any(d["name"].lower() == name.lower() and d["key"] != key for d in defs.values()):
        raise HTTPException(409, "A master with this name exists")
    md.name = name
    if description is not None:
        md.description = description.strip()[:300] or None
    db.commit()


def delete_master(db: Session, key: str) -> None:
    md = _custom_def(db, key)
    defs = _defs(db)
    kids = [d["name"] for d in defs.values() if d["parent_key"] == key]
    if kids:
        raise HTTPException(409, f"Delete the child master(s) first: {', '.join(kids)}")
    forms = _form_usage(db, key).get(key, [])
    if forms:
        raise HTTPException(409, f"This master is used by {len(forms)} form field(s) – remove them in Customization Studio first")
    md.is_active = False
    db.query(MasterValue).filter(MasterValue.master_id == md.id).delete(synchronize_session=False)
    db.commit()


def add_to_form(db: Session, key: str, module: str, label: str) -> int:
    defs = _defs(db)
    if key not in defs:
        raise HTTPException(404, "Master not found")
    if module not in dict(MODULES):
        raise HTTPException(422, "Unknown module")
    label = (label or defs[key]["name"]).strip()[:200]
    fk = "cf_" + (_SLUG.sub("_", label.lower()).strip("_")[:40] or "master")
    if db.query(FormField.id).filter(FormField.module == module, FormField.master_key == key, FormField.is_visible.is_(True)).first():
        raise HTTPException(409, "This form already has a lookup field for this master")
    n, k = 1, fk
    taken = {x for (x,) in db.query(FormField.field_key).filter(FormField.module == module).all()}
    while k in taken:
        n += 1
        k = f"{fk}_{n}"
    sort = (db.query(func.coalesce(func.max(FormField.sort_order), 0)).filter(FormField.module == module).scalar() or 0) + 1
    f = FormField(module=module, section=STUDIO_SECTION, field_key=k, field_type="master", label=label, col_span=1, is_required=False, is_visible=True, is_custom=True,
                  master_key=key, sort_order=sort)
    db.add(f)
    db.commit()
    return f.id
