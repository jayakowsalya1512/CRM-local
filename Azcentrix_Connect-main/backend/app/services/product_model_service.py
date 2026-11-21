"""Product & Price Books (prototype v18 · Sales → Product & Price Books): the company product model and the record
level of a product – specifications, category mapping, record lifecycle / approvals, change windows, the change log,
the category map and the Product Master Excel workbook (download + import).

* The company is the tenant: every table lives in the tenant database, so one company's model, statuses, rules and
  products are never visible to another company.
* Record statuses are ordered. The first is the creation (draft) status, the second the review status, exactly one is
  the approved / locked status and the last is the final (retired) status.
* Moving a product into the approved status, and opening a change window on an approved record, go through the
  Approvals engine (module "product", actions "approve" / "change"). Until approved nothing changes.
* An approved record can only be edited while a change window is open (rule lockEdits). Every edit is written to the
  append-only change log with the window's reason and approver.
"""
from __future__ import annotations

import io
import json
import logging
import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.core.timezone import now_ist
from app.models.all_models import User
from app.models.products import (ProductCategory, ProductCategoryMap, ProductChangeLog, ProductChangeWindow, ProductField, ProductModel,
                                 ProductSpec, ProductStage, ProductStatus)

logger = logging.getLogger(__name__)

# ─── product model templates (prototype PTPL) ─────────────────────────────────
# Each template is a configuration preset an administrator can apply in Configuration → Product model.
TEMPLATES: dict[str, dict[str, Any]] = {
    "mfg": {"n": "Manufacturing · engineered equipment", "d": "Make-to-order equipment with drawings, type tests and factory acceptance before dispatch.",
            "grp": "Application", "cats": ["Switchgear", "Transformers", "Panels", "Automation", "Cables", "Batteries", "Metering", "Accessories", "Instrumentation", "Services"],
            "internal": [], "stages": ["Generation", "Transmission", "Distribution", "Substation automation", "Industrial / captive", "Railways"],
            "statuses": [["Draft", "mu"], ["Engineering Review", "wa"], ["Released", "ok"], ["Phase-out", "inf"], ["Obsolete", "ba"]], "lock": "Released",
            "life": ["Enquiry & sizing", "Design & drawing approval", "Manufacturing", "Factory acceptance test", "Dispatch", "Erection & commissioning", "Warranty & AMC"],
            "extra": [["hsn", "HSN code"], ["make", "Make / buy", "sel", ["Make", "Buy", "Make + bought-out"]], ["lead", "Lead time (weeks)", "num"],
                      ["warranty", "Warranty (months)", "num"], ["std", "Applicable standard"]],
            "specs": [["Rated voltage", "33", "kV", "IEC 62271-200", "Other ratings on request"], ["Rated current", "1250", "A", "—", "630 / 2000 A options"],
                      ["Short-circuit rating", "25 kA / 3 s", "kA", "IEC 62271-100", ""], ["Enclosure", "IP54", "—", "IS 13947", "IP65 for outdoor"]],
            "units": ["Nos", "Set", "Lot", "Km", "MVA"], "code": "{CAT}-{NNNN}"},
    "b2b": {"n": "B2B · trading & distribution", "d": "Catalogue items bought from principals and resold with pack sizes, minimum order quantity, stock and licences.",
            "grp": "Customer segment", "cats": ["Patient monitoring", "Infusion & IV", "Diagnostics", "Consumables", "Surgical instruments", "Spares & service"],
            "internal": [], "stages": ["Hospitals", "Diagnostic centres", "Clinics & nursing homes", "Distributors", "Government / GeM"],
            "statuses": [["Draft", "mu"], ["Pending listing", "wa"], ["Active", "ok"], ["Discontinued", "ba"]], "lock": "Active",
            "life": ["Principal onboarding", "Sourcing & quality check", "Warehousing", "Order & dispatch", "Delivery & installation", "After-sales service"],
            "extra": [["brand", "Brand / principal"], ["hsn", "HSN code"], ["pack", "Pack size"], ["moq", "Minimum order qty", "num"],
                      ["shelf", "Shelf life (months)", "num"], ["lic", "Regulatory licence"]],
            "specs": [["Model", "As offered", "—", "", ""], ["Power supply", "100–240", "V AC", "IEC 60601-1", ""], ["Battery backup", "4", "hours", "", ""],
                      ["Certification", "CE / CDSCO", "—", "", ""]],
            "units": ["Nos", "Box", "Pack", "Set", "Kit"], "code": "MD-{NNNN}"},
    "epc": {"n": "EPC · projects & services", "d": "Packages and rate items estimated against schedules of rates and executed on site.",
            "grp": "Project phase", "cats": ["Substation packages", "Electrical works", "Civil & structural", "Water & pipeline", "Services & O&M"],
            "internal": [], "stages": ["Survey & design", "Civil works", "Supply", "Erection", "Testing & commissioning", "O&M"],
            "statuses": [["Draft", "mu"], ["Estimation Review", "wa"], ["Approved", "ok"], ["Archived", "ba"]], "lock": "Approved",
            "life": ["Survey", "Design & approvals", "Procurement", "Construction", "Testing & commissioning", "Handover & defect liability"],
            "extra": [["sor", "SoR / DSR reference"], ["basis", "Measurement basis"], ["labour", "Labour component %", "num"], ["validity", "Rate valid till", "date"]],
            "specs": [["Scope", "Supply + erection", "—", "", ""], ["Measurement", "As executed", "unit", "IS 1200", ""], ["Execution time", "90", "days", "", ""]],
            "units": ["Lot", "Sqm", "Cum", "Rmt", "Nos", "Job"], "code": "EPC-{NNN}"},
    "waste": {"n": "Waste management solutions", "d": "Process equipment and services mapped to waste streams and process stages, exactly as in the Product Master template.",
              "grp": "Process stage", "cats": ["Wet Waste Solutions", "Dry Waste Solutions", "C&D Waste Solutions", "Municipal / Mixed Waste Solutions", "Legacy Waste Solutions",
                                               "Common Equipment Pool"],
              "internal": ["Common Equipment Pool"], "stages": ["Feeding & Conveying", "Size Reduction", "Screening", "Separation & Sorting", "Treatment & Processing",
                                                                "Recovery & Output", "Ancillary & Support"],
              "statuses": [["Draft", "mu"], ["Technical Review", "wa"], ["Approved", "ok"], ["Obsolete", "ba"]], "lock": "Approved",
              "life": ["Site & waste characterisation", "Material testing", "Engineering & layout", "Fabrication", "Installation & commissioning", "Performance trial", "O&M & spares"],
              "extra": [["cap", "Rated capacity (TPH)"], ["feed", "Applicable feed"], ["out", "Output fraction"], ["power", "Installed power (kW)"]],
              "specs": [["Rated throughput", "10-30", "TPH", "Subject to feed characteristics", "Confirm through material testing"],
                        ["Installed power", "To be engineered", "kW", "IE3 motor preferred", "Final after design freeze"],
                        ["Construction", "As approved", "Not applicable", "MS / wear-resistant lining", "Depends on application"]],
              "units": ["Nos", "Set", "Lot", "Line", "Job", "MT"], "code": "WT-{CAT}-{NNN}"},
}

# Core fields (Product Master sheet) and commercial fields – key, label, type, guidance, required
CORE = [
    ("code", "Product Code", "code", "Unique controlled identifier; do not reuse retired codes.", True),
    ("name", "Product Description", "text", "Short customer-facing product name.", True),
    ("cat", "Product Category", "cat", "Primary category, chosen from the list. List every category where the product is used under Category mapping.", True),
    ("longDesc", "Product Long Description", "ta", "What it is, function in process, applicable feed and expected output.", True),
    ("features", "Features & Benefits", "ta", "Benefit-led statements supported by technical evidence. Separate points with a semicolon.", False),
    ("coo", "COO", "text", "Country of origin for the offered configuration.", False),
    ("policy", "Usage Policy", "ta", "Conditions, restrictions, approvals, safety and permitted use.", False),
    ("guide", "Usage Guidelines", "ta", "Operating, application and maintenance guidance at brochure level.", False),
    ("supply", "Supply Requirements", "ta", "Utilities, foundation, interfaces, civil works, access, optional equipment and exclusions.", False),
    ("status", "Record Status", "status", "Moves through the record statuses set in Configuration. Only the approved status is offered in quotes and brochures.", True),
]
COMMERCIAL = [("unit", "Unit", "unit"), ("list", "List price", "cur"), ("cost", "Standard cost", "cur"), ("oem", "Principal / OEM", "oem"),
              ("stock", "Availability", "sel"), ("gst", "GST %", "num")]
AVAILABILITY = ["In stock", "Made to order", "Low", "Backorder"]
ALWAYS = {"code", "name", "status"}                     # always shown and required
# field key → products_master column (other keys live in products_master.model_data)
FIELD_COL = {"code": "sku", "name": "name", "cat": "category", "longDesc": "description", "features": "features", "coo": "coo", "policy": "usage_policy",
             "guide": "usage_guide", "supply": "supply_req", "status": "record_status", "unit": "unit", "list": "list_price", "cost": "std_cost",
             "oem": "oem_id", "stock": "availability", "gst": "gst_percent"}
DEFAULT_RULES = {"log": True, "quoteApproved": True, "hideInternal": True, "lockEdits": True, "minMargin": 12, "discLimit": 15, "floorPolicy": "Warn",
                 "quoteDiscApproval": True}
FLOOR_POLICIES = ["Warn", "Block", "Approval"]
TONES = ["mu", "wa", "ok", "inf", "ba"]
D0 = Decimal("0")


def _now():
    return now_ist()


def _clean(v: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:n]


# ─── model: seed, read, save ──────────────────────────────────────────────────

def ensure_model(db: Session) -> ProductModel:
    """The company's product model; created once from the Manufacturing template, keeping the catalogue's existing
    categories, units and code series, and placing existing (live) products in the approved status."""
    m = db.query(ProductModel).filter(ProductModel.company_key == "default").first()
    if m:
        return m
    from app.services.product_service import setting
    t = TEMPLATES["mfg"]
    units = []
    try:
        units = [str(x) for x in json.loads(setting(db, "product_units") or "[]") if str(x).strip()]
    except ValueError:
        units = []
    prefix = (setting(db, "product_sku_prefix") or "").strip()
    lim = setting(db, "price_book_approval_limit")
    rules = dict(DEFAULT_RULES)
    try:
        if lim not in (None, ""):
            rules["discLimit"] = float(lim)
    except ValueError:
        pass
    m = ProductModel(company_key="default", template="mfg", name=t["n"], description=t["d"], grouping=t["grp"], roles=["Primary", "Supporting"],
                     lifecycle=list(t["life"]), units=units or list(t["units"]), code_format=(f"{prefix}{{NNNN}}" if prefix else t["code"]),
                     default_specs=[list(s) for s in t["specs"]], rules=rules)
    db.add(m)
    existing = [c for (c,) in db.execute(text("SELECT DISTINCT TRIM(category) FROM products_master WHERE category IS NOT NULL AND TRIM(category) <> '' "
                                                "AND (is_active = 1 OR is_active IS NULL) ORDER BY 1")).all()]
    for i, n in enumerate(existing or t["cats"]):
        db.add(ProductCategory(name=n[:150], is_internal=n in t["internal"], sort_order=i))
    for i, n in enumerate(t["stages"]):
        db.add(ProductStage(name=n, sort_order=i))
    for i, (n, c) in enumerate(t["statuses"]):
        db.add(ProductStatus(name=n, color=c, is_lock=n == t["lock"], sort_order=i))
    _seed_fields(db, t)
    db.flush()
    # products that were already live in the v17 catalogue start in the approved status (recorded in the change log)
    rows = db.execute(text("SELECT id, sku, name FROM products_master WHERE (record_status IS NULL OR record_status = '') AND (is_active = 1 OR is_active IS NULL)")).all()
    if rows:
        db.execute(text("UPDATE products_master SET record_status = :s WHERE record_status IS NULL OR record_status = ''"), {"s": t["lock"]})
        for pid, sku, name in rows:
            db.add(ProductChangeLog(product_id=pid, product_code=sku, product_name=name, field="Record Status", old_value="", new_value=t["lock"],
                                    reason="Catalogue moved to the product model – existing live product", approval_status="Not required"))
    db.flush()
    return m


def _seed_fields(db: Session, t: dict, keep: Optional[dict[str, ProductField]] = None) -> None:
    keep = keep or {}
    order = 0
    for k, lbl, typ, h, req in CORE:
        f = keep.get(k) or ProductField(field_key=k)
        f.label, f.field_type, f.source, f.help, f.sort_order = (f.label if k in keep else lbl), typ, "core", (f.help if k in keep else h), order
        if k not in keep:
            f.is_on, f.is_required = True, req or (t is TEMPLATES["waste"] and k in ("features", "coo"))
        db.add(f)
        order += 1
    for k, lbl, typ in COMMERCIAL:
        f = keep.get(k) or ProductField(field_key=k)
        f.label, f.field_type, f.source, f.sort_order = (f.label if k in keep else lbl), typ, "com", order
        f.options = AVAILABILITY if k == "stock" else None
        if k not in keep:
            f.is_on, f.is_required, f.help = True, False, ""
        db.add(f)
        order += 1
    for ex in t["extra"]:
        k, lbl = ex[0], ex[1]
        f = keep.get(k) or ProductField(field_key=k)
        f.label, f.field_type, f.options, f.source, f.sort_order = (f.label if k in keep else lbl), (ex[2] if len(ex) > 2 else "text"), (ex[3] if len(ex) > 3 else None), "x", order
        if k not in keep:
            f.is_on, f.is_required, f.help = True, False, ""
        db.add(f)
        order += 1


def statuses(db: Session) -> list[ProductStatus]:
    return db.query(ProductStatus).order_by(ProductStatus.sort_order, ProductStatus.id).all()


def lock_status(db: Session) -> str:
    st = statuses(db)
    lk = next((s.name for s in st if s.is_lock), None)
    return lk or (st[min(2, len(st) - 1)].name if st else "Approved")


def categories(db: Session, active: bool = True) -> list[ProductCategory]:
    q = db.query(ProductCategory)
    if active:
        q = q.filter(ProductCategory.is_active == True)
    return q.order_by(ProductCategory.sort_order, ProductCategory.id).all()


def stages(db: Session, active: bool = True) -> list[ProductStage]:
    q = db.query(ProductStage)
    if active:
        q = q.filter(ProductStage.is_active == True)
    return q.order_by(ProductStage.sort_order, ProductStage.id).all()


def fields(db: Session) -> list[ProductField]:
    return db.query(ProductField).order_by(ProductField.sort_order, ProductField.id).all()


def rules(db: Session) -> dict[str, Any]:
    m = ensure_model(db)
    return {**DEFAULT_RULES, **(m.rules or {})}


def model_out(db: Session) -> dict[str, Any]:
    m = ensure_model(db)
    st = statuses(db)
    return {"template": m.template, "name": m.name, "description": m.description or "", "grouping": m.grouping, "roles": list(m.roles or []),
            "life": list(m.lifecycle or []), "units": list(m.units or []), "code": m.code_format, "specs": [list(s) for s in (m.default_specs or [])],
            "rules": {**DEFAULT_RULES, **(m.rules or {})},
            "categories": [{"id": c.id, "name": c.name, "internal": bool(c.is_internal)} for c in categories(db)],
            "stages": [{"id": s.id, "name": s.name} for s in stages(db)],
            "statuses": [{"id": s.id, "name": s.name, "color": s.color, "lock": bool(s.is_lock)} for s in st],
            "lock": lock_status(db), "draft": st[0].name if st else "Draft", "review": st[1].name if len(st) > 1 else None, "final": st[-1].name if st else None,
            "fields": [{"key": f.field_key, "label": f.label, "type": f.field_type, "options": f.options or [], "source": f.source, "on": bool(f.is_on) or f.field_key in ALWAYS,
                        "req": bool(f.is_required) or f.field_key in ALWAYS, "help": f.help or ""} for f in fields(db)],
            "templates": [{"key": k, "name": t["n"], "description": t["d"], "grouping": t["grp"], "categories": len(t["cats"]), "stages": t["stages"][:3],
                           "statuses": [s[0] for s in t["statuses"]]} for k, t in TEMPLATES.items()],
            "updated_at": m.updated_at.isoformat() if m.updated_at else None}


def _used_categories(db: Session) -> dict[int, int]:
    return {cid: n for cid, n in db.execute(text("SELECT m.category_id, COUNT(DISTINCT m.product_id) FROM product_category_maps m JOIN products_master p ON p.id = m.product_id "
                                                 "WHERE (p.is_active = 1 OR p.is_active IS NULL) GROUP BY m.category_id")).all()}


def _used_stages(db: Session) -> dict[int, int]:
    return {sid: n for sid, n in db.execute(text("SELECT m.stage_id, COUNT(DISTINCT m.product_id) FROM product_category_maps m JOIN products_master p ON p.id = m.product_id "
                                                 "WHERE (p.is_active = 1 OR p.is_active IS NULL) GROUP BY m.stage_id")).all()}


def _status_use(db: Session) -> dict[str, int]:
    return {s: n for s, n in db.execute(text("SELECT record_status, COUNT(*) FROM products_master WHERE (is_active = 1 OR is_active IS NULL) GROUP BY record_status")).all()}


def _names(items: list, label: str, n: int = 150) -> list[str]:
    out = []
    for x in items or []:
        s = _clean(x if isinstance(x, str) else (x or {}).get("name"), n)
        if not s:
            raise HTTPException(422, f"{label}: names cannot be empty")
        if s.lower() in {o.lower() for o in out}:
            raise HTTPException(422, f"{label}: “{s}” is listed twice")
        out.append(s)
    return out


def save_model(db: Session, cu: User, body: dict[str, Any]) -> dict[str, Any]:
    """Configuration → save any part of the company product model. Values in use cannot be removed."""
    m = ensure_model(db)
    if "name" in body:
        n = _clean(body["name"], 120)
        if len(n) < 2:
            raise HTTPException(422, "Product model name must be at least 2 characters")
        m.name = n
    if "grouping" in body:
        g = _clean(body["grouping"], 60)
        if not g:
            raise HTTPException(422, "Give the grouping used in category mapping a name")
        m.grouping = g
    for key, attr, label in (("roles", "roles", "Mapping roles"), ("life", "lifecycle", "Product delivery lifecycle"), ("units", "units", "Units")):
        if key in body:
            vals = _names(body[key], label, 60 if key != "life" else 150)
            if not vals:
                raise HTTPException(422, f"{label}: keep at least one value")
            if key == "roles":
                if "Primary" not in vals:
                    raise HTTPException(422, "Mapping roles must keep “Primary”")
                used = {r for (r,) in db.execute(text("SELECT DISTINCT role FROM product_category_maps")).all()}
                gone = used - set(vals)
                if gone:
                    raise HTTPException(409, f"Role “{sorted(gone)[0]}” is used in category mappings – re-map them first")
            if key == "units":
                used = {u for (u,) in db.execute(text("SELECT DISTINCT unit FROM products_master WHERE unit IS NOT NULL AND unit <> '' AND (is_active = 1 OR is_active IS NULL)")).all()}
                gone = sorted(u for u in used if u not in vals)
                if gone:
                    raise HTTPException(409, f"Unit “{gone[0]}” is used by products – change them first")
            setattr(m, attr, vals)
    if "code" in body:
        c = _clean(body["code"], 40)
        if not c or not any(t in c for t in ("{NNNN}", "{NNN}")):
            raise HTTPException(422, "Product code format needs a running number: {NNN} or {NNNN} (optionally {CAT})")
        m.code_format = c
    if "specs" in body:
        sp = []
        for r in body["specs"] or []:
            r = [_clean(x, 300) for x in (list(r) + [""] * 5)[:5]]
            if not r[0]:
                raise HTTPException(422, "Default specification parameters need a name")
            sp.append(r)
        m.default_specs = sp
    if "rules" in body:
        r = {**DEFAULT_RULES, **(m.rules or {})}
        for k, v in (body["rules"] or {}).items():
            if k in ("log", "quoteApproved", "hideInternal", "lockEdits", "quoteDiscApproval"):
                r[k] = bool(v)
            elif k in ("minMargin", "discLimit"):
                try:
                    n = float(v)
                except (TypeError, ValueError):
                    raise HTTPException(422, "Minimum margin and discount limit must be numbers")
                if not 0 <= n <= 100:
                    raise HTTPException(422, "Minimum margin and discount limit must be 0–100 %")
                r[k] = n
            elif k == "floorPolicy":
                if v not in FLOOR_POLICIES:
                    raise HTTPException(422, "Below-floor policy must be Warn, Block or Approval")
                r[k] = v
        m.rules = r
        from app.services.product_service import _put_setting
        _put_setting(db, cu, "price_book_approval_limit", str(r["discLimit"]), "number")   # keep the v17 setting in step
    if "categories" in body:
        _save_categories(db, body["categories"] or [])
    if "stages" in body:
        _save_stages(db, body["stages"] or [])
    if "statuses" in body:
        _save_statuses(db, cu, body["statuses"] or [])
    if "fields" in body:
        _save_fields(db, body["fields"] or [])
    m.updated_by = cu.id
    db.flush()
    return model_out(db)


def _save_categories(db: Session, items: list[dict]) -> None:
    names = _names(items, "Product categories")
    if not names:
        raise HTTPException(422, "Keep at least one product category")
    cur = {c.id: c for c in db.query(ProductCategory).all()}
    used = _used_categories(db)
    keep: set[int] = set()
    for i, (x, n) in enumerate(zip(items, names)):
        cid = x.get("id") if isinstance(x, dict) else None
        c = cur.get(int(cid)) if cid else next((c for c in cur.values() if c.name.lower() == n.lower()), None)
        if c is None:
            c = ProductCategory(name=n)
            db.add(c)
        elif c.name != n:
            db.execute(text("UPDATE products_master SET category = :n WHERE category = :o"), {"n": n, "o": c.name})
            c.name = n
        c.is_internal = bool(x.get("internal")) if isinstance(x, dict) else False
        c.is_active, c.sort_order = True, i
        if c.id:
            keep.add(c.id)
    for cid, c in cur.items():
        if cid not in keep and c.is_active:
            in_use = used.get(cid, 0) + (db.execute(text("SELECT COUNT(*) FROM products_master WHERE category = :n AND (is_active = 1 OR is_active IS NULL)"), {"n": c.name}).scalar() or 0)
            if in_use:
                raise HTTPException(409, f"“{c.name}” is used by {in_use} product{'s' if in_use > 1 else ''} – re-map them first")
            c.is_active = False


def _save_stages(db: Session, items: list[dict]) -> None:
    names = _names(items, "Grouping values")
    if not names:
        raise HTTPException(422, "Keep at least one value in the grouping list")
    cur = {s.id: s for s in db.query(ProductStage).all()}
    used = _used_stages(db)
    keep: set[int] = set()
    for i, (x, n) in enumerate(zip(items, names)):
        sid = x.get("id") if isinstance(x, dict) else None
        s = cur.get(int(sid)) if sid else next((s for s in cur.values() if s.name.lower() == n.lower()), None)
        if s is None:
            s = ProductStage(name=n)
            db.add(s)
        s.name, s.is_active, s.sort_order = n, True, i
        if s.id:
            keep.add(s.id)
    for sid, s in cur.items():
        if sid not in keep and s.is_active:
            if used.get(sid):
                raise HTTPException(409, f"“{s.name}” is used by {used[sid]} product mapping{'s' if used[sid] > 1 else ''} – re-map them first")
            s.is_active = False


def _save_statuses(db: Session, cu: User, items: list[dict]) -> None:
    names = _names(items, "Record statuses", 60)
    if len(names) < 3:
        raise HTTPException(422, "Keep at least three record statuses (draft, approved and final)")
    locks = [n for x, n in zip(items, names) if x.get("lock")]
    if len(locks) != 1:
        raise HTTPException(422, "Choose exactly one approved status")
    if names.index(locks[0]) in (0, len(names) - 1):
        raise HTTPException(422, "The approved status cannot be the first (draft) or the last (final) status")
    cur = {s.id: s for s in db.query(ProductStatus).all()}
    use = _status_use(db)
    keep: set[int] = set()
    for i, (x, n) in enumerate(zip(items, names)):
        sid = x.get("id")
        s = cur.get(int(sid)) if sid else None
        tone = x.get("color") if x.get("color") in TONES else "inf"
        if s is None:
            s = ProductStatus(name=n)
            db.add(s)
        elif s.name != n:
            db.execute(text("UPDATE products_master SET record_status = :n WHERE record_status = :o"), {"n": n, "o": s.name})
            db.execute(text("UPDATE products_master SET pending_status = :n WHERE pending_status = :o"), {"n": n, "o": s.name})
            s.name = n
        s.color, s.is_lock, s.sort_order = tone, n == locks[0], i
        if s.id:
            keep.add(s.id)
    for sid, s in cur.items():
        if sid not in keep:
            if use.get(s.name):
                raise HTTPException(409, f"Products are in “{s.name}” – move them first")
            db.delete(s)


def _save_fields(db: Session, items: list[dict]) -> None:
    cur = {f.field_key: f for f in fields(db)}
    seen = set()
    for i, x in enumerate(items):
        k = str(x.get("key") or "").strip()
        if not k:
            continue
        lbl = _clean(x.get("label"), 150)
        if not lbl:
            raise HTTPException(422, "Field labels cannot be empty")
        f = cur.get(k)
        if f is None:
            if not re.fullmatch(r"cf_[a-z0-9_]{1,40}", k):
                raise HTTPException(422, "Unknown field")
            typ = x.get("type") if x.get("type") in ("text", "num", "date", "ta") else "text"
            f = ProductField(field_key=k, field_type=typ, source="custom")
            db.add(f)
        f.label, f.help, f.sort_order = lbl, _clean(x.get("help"), 500), i
        f.is_on = True if k in ALWAYS else bool(x.get("on"))
        f.is_required = True if k in ALWAYS else (bool(x.get("req")) and f.is_on)
        seen.add(k)
    for k, f in cur.items():
        if k not in seen and f.source == "custom":
            db.delete(f)


def add_custom_field(db: Session, cu: User, label: str, typ: str, req: bool) -> dict[str, Any]:
    lbl = _clean(label, 150)
    if len(lbl) < 2:
        raise HTTPException(422, "Give the field a label")
    if typ not in ("text", "num", "date", "ta"):
        raise HTTPException(422, "Field type must be Text, Number, Date or Long text")
    if db.query(ProductField.id).filter(ProductField.label == lbl).first():
        raise HTTPException(409, f"A field labelled “{lbl}” already exists")
    key = "cf_" + re.sub(r"[^a-z0-9]+", "_", lbl.lower()).strip("_")[:30]
    n, base = 1, key
    while db.query(ProductField.id).filter(ProductField.field_key == key).first():
        n += 1
        key = f"{base}_{n}"
    order = (db.execute(text("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM product_fields")).scalar() or 0)
    db.add(ProductField(field_key=key, label=lbl, field_type=typ, source="custom", is_on=True, is_required=bool(req), help="", sort_order=order))
    ensure_model(db).updated_by = cu.id
    db.flush()
    return model_out(db)


def apply_template(db: Session, cu: User, request: Optional[Request], key: str) -> dict[str, Any]:
    """Apply a model preset: lists, statuses, fields and lifecycle follow the template. Values still used by products
    are kept (so no mapping or product loses its value); products in a status the template does not have move to the
    template's first status (logged)."""
    t = TEMPLATES.get(key)
    if not t:
        raise HTTPException(422, "Unknown product model")
    m = ensure_model(db)
    m.template, m.name, m.description, m.grouping = key, t["n"], t["d"], t["grp"]
    m.lifecycle, m.default_specs = list(t["life"]), [list(s) for s in t["specs"]]
    used_units = [u for (u,) in db.execute(text("SELECT DISTINCT unit FROM products_master WHERE unit IS NOT NULL AND unit <> '' AND (is_active = 1 OR is_active IS NULL)")).all()]
    m.units = list(t["units"]) + [u for u in used_units if u not in t["units"]]
    if not re.search(r"\{NNN", m.code_format or "") or key != "mfg":
        m.code_format = t["code"]
    used_c = _used_categories(db)
    cats = categories(db, active=False)
    in_use = {c.name for c in cats if c.is_active and (used_c.get(c.id) or db.execute(text("SELECT 1 FROM products_master WHERE category = :n AND (is_active = 1 OR is_active IS NULL) LIMIT 1"), {"n": c.name}).first())}
    by = {c.name.lower(): c for c in cats}
    order = 0
    for n in t["cats"] + sorted(in_use - set(t["cats"])):
        c = by.get(n.lower()) or ProductCategory(name=n)
        c.is_active, c.is_internal, c.sort_order = True, n in t["internal"], order
        db.add(c)
        order += 1
    for c in cats:
        if c.name not in t["cats"] and c.name not in in_use:
            c.is_active = False
    used_s = _used_stages(db)
    sts = stages(db, active=False)
    s_in_use = {s.name for s in sts if s.is_active and used_s.get(s.id)}
    by_s = {s.name.lower(): s for s in sts}
    order = 0
    for n in t["stages"] + sorted(s_in_use - set(t["stages"])):
        s = by_s.get(n.lower()) or ProductStage(name=n)
        s.is_active, s.sort_order = True, order
        db.add(s)
        order += 1
    for s in sts:
        if s.name not in t["stages"] and s.name not in s_in_use:
            s.is_active = False
    first = t["statuses"][0][0]
    names = [s[0] for s in t["statuses"]]
    moved = db.execute(text("SELECT id, sku, name, record_status FROM products_master WHERE (is_active = 1 OR is_active IS NULL) AND (record_status IS NULL OR record_status NOT IN :n)").bindparams(
        bindparam("n", expanding=True)), {"n": names}).all()
    for pid, sku, name, st in moved:
        db.add(ProductChangeLog(product_id=pid, product_code=sku, product_name=name, field="Record Status", old_value=st or "", new_value=first,
                                reason=f"Product model changed to {t['n']}", changed_by=cu.id, approval_status="Not required"))
    db.execute(text("UPDATE products_master SET pending_status = NULL, status_request_id = NULL WHERE pending_status IS NOT NULL"))
    if moved:
        db.execute(text("UPDATE products_master SET record_status = :f WHERE (record_status IS NULL OR record_status NOT IN :n)").bindparams(
            bindparam("n", expanding=True)), {"f": first, "n": names})
    db.query(ProductStatus).delete()
    for i, (n, c) in enumerate(t["statuses"]):
        db.add(ProductStatus(name=n, color=c, is_lock=n == t["lock"], sort_order=i))
    keep = {f.field_key: f for f in fields(db)}
    for k, f in list(keep.items()):
        if f.source == "x" and k not in {e[0] for e in t["extra"]}:
            db.delete(f)
            del keep[k]
    _seed_fields(db, t, keep)
    m.updated_by = cu.id
    db.flush()
    return model_out(db)


# ─── code series ──────────────────────────────────────────────────────────────

def _abbr(s: str) -> str:
    w = [x for x in re.sub(r"[^A-Za-z ]", " ", str(s or "GEN")).split(" ") if len(x) > 1 and not re.fullmatch(r"(?i)and|of|the|for", x)]
    return ("".join(x[0] for x in w)[:3] if len(w) > 1 else (w[0] if w else "GEN")[:3]).upper()


def next_code(db: Session, cat: str, name: str) -> str:
    m = ensure_model(db)
    fmt = m.code_format or "{CAT}-{NNNN}"
    ab = _abbr(name if m.template == "waste" else cat)
    n = (db.execute(text("SELECT COUNT(*) FROM products_master")).scalar() or 0) + 1
    for _ in range(100000):
        code = fmt.replace("{CAT}", ab).replace("{NNNN}", str(1000 + n)).replace("{NNN}", str(n).zfill(3))
        if not db.execute(text("SELECT 1 FROM products_master WHERE sku = :c LIMIT 1"), {"c": code}).first():
            return code
        n += 1
    raise HTTPException(409, "Could not generate a unique product code – check the code format")


# ─── change log ───────────────────────────────────────────────────────────────

def log_change(db: Session, cu: Optional[User], p: Optional[dict], field: str, old: Any, new: Any, reason: str = "", approver: str = "",
               approval: str = "Not required", book_id: Optional[int] = None, request_id: Optional[int] = None, force: bool = False) -> None:
    o, n = ("" if old is None else str(old)), ("" if new is None else str(new))
    if o == n and not force:
        return
    db.add(ProductChangeLog(product_id=p["id"] if p else None, price_book_id=book_id, product_code=(p or {}).get("code"), product_name=(p or {}).get("name"),
                            field=field[:200], old_value=o[:5000], new_value=n[:5000], reason=(reason or "")[:500] or None, changed_by=cu.id if cu else None,
                            approver_name=(approver or "")[:150] or None, approval_status=approval, approval_request_id=request_id))


def change_log(db: Session, product_id: Optional[int] = None, user_id: Optional[int] = None, date_from: Optional[str] = None, date_to: Optional[str] = None,
               q: str = "", book_id: Optional[int] = None, limit: int = 2000) -> list[dict[str, Any]]:
    from app.models.products import PriceBook, ProductPriceHistory
    from app.services.product_service import names
    qq = db.query(ProductChangeLog)
    if product_id:
        qq = qq.filter(ProductChangeLog.product_id == product_id)
    if book_id:
        qq = qq.filter(ProductChangeLog.price_book_id == book_id)
    if user_id:
        qq = qq.filter(ProductChangeLog.changed_by == user_id)
    if date_from:
        qq = qq.filter(ProductChangeLog.created_at >= date_from)
    if date_to:
        qq = qq.filter(ProductChangeLog.created_at < f"{date_to} 23:59:59.999")
    rows = qq.order_by(ProductChangeLog.id.desc()).limit(limit).all()
    books = {b.id: b.name for b in db.query(PriceBook.id, PriceBook.name).all()}
    out = [{"id": f"c{r.id}", "date": r.created_at.isoformat() if r.created_at else None, "product_id": r.product_id, "code": r.product_code or "",
            "name": r.product_name or "", "book": books.get(r.price_book_id, "") if r.price_book_id else "", "field": r.field, "old": r.old_value or "",
            "new": r.new_value or "", "reason": r.reason or "", "by_id": r.changed_by, "approver": r.approver_name or "", "approval": r.approval_status or ""} for r in rows]
    # v17 price history (before the change log existed) stays visible, read-only
    hq = db.query(ProductPriceHistory).filter(ProductPriceHistory.changed_at < (db.query(ProductChangeLog.created_at).order_by(ProductChangeLog.id).limit(1).scalar() or _now()))
    if product_id:
        hq = hq.filter(ProductPriceHistory.product_id == product_id)
    if book_id:
        hq = hq.filter(ProductPriceHistory.price_book_id == book_id)
    if user_id:
        hq = hq.filter(ProductPriceHistory.changed_by == user_id)
    if date_from:
        hq = hq.filter(ProductPriceHistory.changed_at >= date_from)
    if date_to:
        hq = hq.filter(ProductPriceHistory.changed_at < f"{date_to} 23:59:59.999")
    hist = hq.order_by(ProductPriceHistory.id.desc()).limit(limit).all()
    pids = {h.product_id for h in hist if h.product_id}
    pinfo = {i: (s, n) for i, s, n in db.execute(text("SELECT id, sku, name FROM products_master WHERE id IN :i").bindparams(
        bindparam("i", expanding=True)), {"i": list(pids)}).all()} if pids else {}
    lbl = {"list_price": "Product Master · List price", "std_cost": "Product Master · Standard cost", "adjustment": "Price book · Adjustment %", "override": "Price book · Override"}
    for h in hist:
        s, n = pinfo.get(h.product_id, ("", ""))
        out.append({"id": f"h{h.id}", "date": h.changed_at.isoformat() if h.changed_at else None, "product_id": h.product_id, "code": s or "", "name": n or "",
                    "book": books.get(h.price_book_id, "") if h.price_book_id else "", "field": lbl.get(h.field, h.field),
                    "old": "" if h.old_value is None else str(h.old_value), "new": "" if h.new_value is None else str(h.new_value), "reason": h.note or "",
                    "by_id": h.changed_by, "approver": "", "approval": "Not required"})
    if q.strip():
        ql = q.strip().lower()
        out = [r for r in out if any(ql in str(r[k]).lower() for k in ("code", "name", "field", "old", "new", "reason", "book"))]
    who = names(db, [r["by_id"] for r in out])
    for r in out:
        r["by"] = who.get(r["by_id"], "")
    out.sort(key=lambda r: r["date"] or "", reverse=True)
    return out[:limit]


# ─── change windows & edit gating ─────────────────────────────────────────────

def open_window(db: Session, pid: int) -> Optional[ProductChangeWindow]:
    return db.query(ProductChangeWindow).filter(ProductChangeWindow.product_id == pid, ProductChangeWindow.status.in_(("open", "pending"))).order_by(ProductChangeWindow.id.desc()).first()


def window_out(w: Optional[ProductChangeWindow]) -> Optional[dict]:
    if not w:
        return None
    return {"id": w.id, "reason": w.reason, "status": w.status, "approver": w.approver_name or "", "opened_at": w.opened_at.isoformat() if w.opened_at else None}


def edit_context(db: Session, p: dict) -> dict[str, Any]:
    """How an edit of product p is authorised: raises when the record is waiting for approval or is locked without
    an open change window. Returns the reason / approver to write to the change log and whether to log at all."""
    if p.get("pending_status"):
        raise HTTPException(409, f"{p['code']} is waiting for approval to move to {p['pending_status']} – it cannot be edited until that is decided")
    r = rules(db)
    if p["status"] == lock_status(db):
        w = open_window(db, p["id"])
        if r["lockEdits"]:
            if not w or w.status != "open":
                raise HTTPException(409, f"This record is {p['status']}. Open a change window (reason + approval) before editing it."
                                    if not w else "The change window for this record is waiting for approval")
            return {"reason": w.reason, "approver": w.approver_name or "", "approval": "Approved", "log": True, "window": w.id}
        return {"reason": w.reason if w and w.status == "open" else "Edited after approval", "approver": w.approver_name if w and w.status == "open" else "",
                "approval": "Approved" if w and w.status == "open" else "Not required", "log": True, "window": None}
    return {"reason": "Edited before approval", "approver": "", "approval": "Not required", "log": bool(r["log"]), "window": None}


def _approval(db: Session, request: Optional[Request], cu: User, action: str, rid: int):
    from app.services.generic_approval_engine import create_generic_approval_request
    return create_generic_approval_request(db, tenant_id=getattr(getattr(getattr(request, "state", None), "tenant", None), "id", None) if request else None,
                                           requester=cu, module_key="product", action_key=action, record_id=rid)


def _auto_approver(req, cu: User) -> str:
    return "Auto-approved (no approval rule)" if (req.approval_mode or "") == "auto" else f"{cu.full_name} (top of approval hierarchy)"


def request_window(db: Session, cu: User, request: Optional[Request], p: dict, reason: str) -> dict[str, Any]:
    reason = _clean(reason, 500)
    if len(reason) < 3:
        raise HTTPException(422, "Give a reason for the change")
    if p["status"] != lock_status(db):
        raise HTTPException(409, f"Only {lock_status(db)} records need a change window – this one can be edited directly")
    if p.get("pending_status"):
        raise HTTPException(409, "This record is waiting for a status approval")
    if open_window(db, p["id"]):
        raise HTTPException(409, "A change window is already open or waiting for approval")
    w = ProductChangeWindow(product_id=p["id"], reason=reason, status="pending", opened_by=cu.id)
    db.add(w)
    db.flush()
    req = _approval(db, request, cu, "change", w.id)
    w.approval_request_id = req.id
    if (req.status or "").lower() == "approved":
        w.status, w.approver_name = "open", _auto_approver(req, cu)
        log_change(db, cu, p, "Change window", "", "Opened", reason, w.approver_name, "Approved", request_id=req.id, force=True)
        return {"window": window_out(w), "message": "Change window open – edits are now logged"}
    log_change(db, cu, p, "Change window", "", "Requested", reason, "", "Pending", request_id=req.id, force=True)
    return {"window": window_out(w), "message": "Change window sent for approval – you can edit once it is approved"}


def close_window(db: Session, cu: User, p: dict) -> None:
    w = open_window(db, p["id"])
    if not w:
        raise HTTPException(404, "No change window is open")
    w.status, w.closed_at = "closed", _now()
    log_change(db, cu, p, "Change window", "Open", "Closed", w.reason, w.approver_name or "", "Not required", force=True)


# ─── specifications & category mapping ────────────────────────────────────────

def specs(db: Session, pid: int) -> list[dict[str, Any]]:
    return [{"id": s.id, "p": s.parameter, "v": s.value or "", "u": s.unit or "", "std": s.standard or "", "rm": s.remarks or ""}
            for s in db.query(ProductSpec).filter(ProductSpec.product_id == pid).order_by(ProductSpec.sort_order, ProductSpec.id).all()]


def _spec_rows(items: list[dict]) -> list[dict[str, str]]:
    out = []
    for i, x in enumerate(items or []):
        r = {"id": x.get("id"), "p": _clean(x.get("p"), 200), "v": _clean(x.get("v"), 300), "u": _clean(x.get("u"), 60), "std": _clean(x.get("std"), 300), "rm": _clean(x.get("rm"), 500)}
        if not r["p"]:
            raise HTTPException(422, f"Specification row {i + 1}: the parameter name is required")
        if not r["v"]:
            raise HTTPException(422, f"Specification “{r['p']}”: enter a value or range")
        out.append(r)
    seen = set()
    for r in out:
        if r["p"].lower() in seen:
            raise HTTPException(422, f"Specification “{r['p']}” is listed twice")
        seen.add(r["p"].lower())
    return out


def save_specs(db: Session, cu: User, p: dict, items: list[dict], ctx: dict) -> list[dict[str, Any]]:
    rows = _spec_rows(items)
    cur = {s.id: s for s in db.query(ProductSpec).filter(ProductSpec.product_id == p["id"]).all()}
    lbl = {"v": "Value", "u": "Unit", "std": "Standard", "rm": "Remarks"}
    keep = set()
    old_order = [s.parameter for s in sorted(cur.values(), key=lambda s: (s.sort_order, s.id))]
    for i, r in enumerate(rows):
        s = cur.get(int(r["id"])) if r.get("id") and int(r["id"]) in cur else None
        if s is None:
            s = ProductSpec(product_id=p["id"], parameter=r["p"])
            db.add(s)
            if ctx["log"]:
                log_change(db, cu, p, "Specifications · " + r["p"], "", f"{r['v']} {r['u']}".strip() + " (row added)", ctx["reason"], ctx["approver"], ctx["approval"])
        else:
            keep.add(s.id)
            if ctx["log"]:
                if s.parameter != r["p"]:
                    log_change(db, cu, p, "Specifications · " + s.parameter, s.parameter, r["p"], ctx["reason"], ctx["approver"], ctx["approval"])
                for k, col in (("v", "value"), ("u", "unit"), ("std", "standard"), ("rm", "remarks")):
                    if (getattr(s, col) or "") != r[k]:
                        log_change(db, cu, p, f"Specifications · {r['p']} · {lbl[k]}", getattr(s, col) or "", r[k], ctx["reason"], ctx["approver"], ctx["approval"])
        s.parameter, s.value, s.unit, s.standard, s.remarks, s.sort_order, s.updated_by = r["p"], r["v"], r["u"] or None, r["std"] or None, r["rm"] or None, i, cu.id
    for sid, s in cur.items():
        if sid not in keep:
            if ctx["log"]:
                log_change(db, cu, p, "Specifications · " + s.parameter, f"{s.value or ''} {s.unit or ''}".strip(), "Row removed", ctx["reason"], ctx["approver"], ctx["approval"])
            db.delete(s)
    kept_old = [n for n in old_order if n in {r["p"] for r in rows}]
    kept_new = [r["p"] for r in rows if r["p"] in set(old_order)]
    if ctx["log"] and kept_old != kept_new:
        log_change(db, cu, p, "Specifications · order", ", ".join(kept_old), ", ".join(kept_new), ctx["reason"], ctx["approver"], ctx["approval"])
    _touch(db, cu, p["id"])
    db.flush()
    return specs(db, p["id"])


def mappings(db: Session, pid: Optional[int] = None) -> list[dict[str, Any]]:
    q = ("SELECT m.id, m.product_id, m.category_id, c.name AS cat, c.is_internal, m.stage_id, s.name AS stage, m.role, m.remarks FROM product_category_maps m "
         "JOIN product_categories c ON c.id = m.category_id JOIN product_stages s ON s.id = m.stage_id ")
    rows = db.execute(text(q + ("WHERE m.product_id = :p " if pid else "") + "ORDER BY m.product_id, m.sort_order, m.id"), {"p": pid}).mappings().all()
    return [{"id": r["id"], "product_id": r["product_id"], "category_id": r["category_id"], "cat": r["cat"], "internal": bool(r["is_internal"]), "stage_id": r["stage_id"],
             "stage": r["stage"], "role": r["role"], "rm": r["remarks"] or ""} for r in rows]


def save_mappings(db: Session, cu: User, p: dict, items: list[dict], ctx: dict) -> list[dict[str, Any]]:
    m = ensure_model(db)
    cats = {c.id: c for c in categories(db)}
    sts = {s.id: s for s in stages(db)}
    roles = list(m.roles or ["Primary", "Supporting"])
    rows, seen = [], set()
    for i, x in enumerate(items or []):
        try:
            cid, sid = int(x.get("category_id")), int(x.get("stage_id"))
        except (TypeError, ValueError):
            raise HTTPException(422, f"Mapping row {i + 1}: choose a category and a {m.grouping.lower()}")
        if cid not in cats:
            raise HTTPException(422, f"Mapping row {i + 1}: choose a configured category")
        if sid not in sts:
            raise HTTPException(422, f"Mapping row {i + 1}: choose a configured {m.grouping.lower()}")
        role = str(x.get("role") or "")
        if role not in roles:
            raise HTTPException(422, f"Mapping row {i + 1}: role must be one of {', '.join(roles)}")
        if (cid, sid) in seen:
            raise HTTPException(409, f"{cats[cid].name} · {sts[sid].name} is mapped twice – each category and {m.grouping.lower()} can be used once")
        seen.add((cid, sid))
        rows.append({"id": x.get("id"), "cid": cid, "sid": sid, "role": role, "rm": _clean(x.get("rm"), 500)})
    if sum(1 for r in rows if r["role"] == "Primary") > 1:
        raise HTTPException(422, "A product can have only one Primary mapping – set the others to Supporting")
    cur = {x.id: x for x in db.query(ProductCategoryMap).filter(ProductCategoryMap.product_id == p["id"]).all()}
    desc = lambda cid, sid, role: f"{role} · {sts[sid].name if sid in sts else sid}"
    keep = set()
    # free the unique key first: rows that move to another (category, stage) are re-written after deletions
    for r in rows:
        x = cur.get(int(r["id"])) if r.get("id") and int(r["id"]) in cur else None
        if x is not None:
            keep.add(x.id)
    for xid, x in cur.items():
        if xid not in keep:
            if ctx["log"]:
                cn = db.get(ProductCategory, x.category_id)
                log_change(db, cu, p, "Category Mapping · " + (cn.name if cn else str(x.category_id)), desc(x.category_id, x.stage_id, x.role), "Removed",
                           ctx["reason"], ctx["approver"], ctx["approval"])
            db.delete(x)
    db.flush()
    for i, r in enumerate(rows):
        x = cur.get(int(r["id"])) if r.get("id") and int(r["id"]) in cur else None
        if x is None:
            x = ProductCategoryMap(product_id=p["id"], category_id=r["cid"], stage_id=r["sid"])
            db.add(x)
            if ctx["log"]:
                log_change(db, cu, p, "Category Mapping · " + cats[r["cid"]].name, "", "Added · " + desc(r["cid"], r["sid"], r["role"]), ctx["reason"], ctx["approver"], ctx["approval"])
        elif ctx["log"]:
            old_c = db.get(ProductCategory, x.category_id)
            if x.category_id != r["cid"]:
                log_change(db, cu, p, "Category Mapping · Category", old_c.name if old_c else "", cats[r["cid"]].name, ctx["reason"], ctx["approver"], ctx["approval"])
            if x.stage_id != r["sid"]:
                old_s = db.get(ProductStage, x.stage_id)
                log_change(db, cu, p, f"Category Mapping · {cats[r['cid']].name} · {m.grouping}", old_s.name if old_s else "", sts[r["sid"]].name, ctx["reason"], ctx["approver"], ctx["approval"])
            if x.role != r["role"]:
                log_change(db, cu, p, f"Category Mapping · {cats[r['cid']].name} · Role", x.role, r["role"], ctx["reason"], ctx["approver"], ctx["approval"])
            if (x.remarks or "") != r["rm"]:
                log_change(db, cu, p, f"Category Mapping · {cats[r['cid']].name} · Remarks", x.remarks or "", r["rm"], ctx["reason"], ctx["approver"], ctx["approval"])
        x.category_id, x.stage_id, x.role, x.remarks, x.sort_order = r["cid"], r["sid"], r["role"], r["rm"] or None, i
        db.flush()
    _touch(db, cu, p["id"])
    db.flush()
    return mappings(db, p["id"])


def _touch(db: Session, cu: User, pid: int) -> None:
    db.execute(text("UPDATE products_master SET updated_by = :u, updated_at = :n WHERE id = :i"), {"u": cu.id, "n": _now(), "i": pid})


# ─── lifecycle ────────────────────────────────────────────────────────────────

def missing_for_review(db: Session, p: dict) -> list[str]:
    miss = []
    for f in fields(db):
        if not (f.is_on and f.is_required) or f.field_key in ("status", "code"):
            continue
        v = p["fields"].get(f.field_key)
        if v in (None, "") or (isinstance(v, str) and not v.strip()):
            miss.append(f.label)
    return miss


def actions(db: Session, p: dict) -> dict[str, Any]:
    """Lifecycle actions offered on the record page (prototype pxPage buttons), from the configured statuses."""
    st = [s.name for s in statuses(db)]
    if p["status"] not in st or p.get("pending_status"):
        return {"next": None, "final": None, "return": None} if p.get("pending_status") else {"next": st[0] if st else None, "final": None, "return": None}
    si, n, lk = st.index(p["status"]), len(st), st.index(lock_status(db))
    return {"next": st[si + 1] if si < n - 2 else None, "next_label": (f"Submit for {st[si + 1].lower()}" if si == 0 else f"Move to {st[si + 1]}") if si < n - 2 else None,
            "final": st[-1] if si < n - 1 else None, "return": st[0] if 0 < si < lk else None}


def move_status(db: Session, cu: User, request: Optional[Request], p: dict, to: str, reason: str) -> dict[str, Any]:
    st = [s.name for s in statuses(db)]
    if to not in st:
        raise HTTPException(422, "Choose a configured record status")
    if p.get("pending_status"):
        raise HTTPException(409, f"Already waiting for approval to move to {p['pending_status']}")
    a = actions(db, p)
    reason = _clean(reason, 500)
    if to == a.get("next"):
        kind = "next"
    elif to == a.get("final"):
        kind = "final"
    elif to == a.get("return"):
        kind = "return"
    else:
        raise HTTPException(409, f"{p['code']} cannot move from {p['status']} to {to} – follow the configured record lifecycle")
    if kind in ("final", "return") and len(reason) < 3:
        raise HTTPException(422, "Give a reason for this status change")
    if kind == "next":
        miss = missing_for_review(db, p)
        if miss:
            raise HTTPException(422, "Fill the required fields first: " + ", ".join(miss))
        if not db.query(ProductSpec.id).filter(ProductSpec.product_id == p["id"]).first():
            raise HTTPException(422, "Add at least one specification row first")
        prim = db.query(ProductCategoryMap.id).filter(ProductCategoryMap.product_id == p["id"], ProductCategoryMap.role == "Primary").count()
        if prim != 1:
            raise HTTPException(422, "Set exactly one Primary category mapping first")
    lock = lock_status(db)
    if to == lock:
        req = _approval(db, request, cu, "approve", p["id"])
        if (req.status or "").lower() != "approved":
            db.execute(text("UPDATE products_master SET pending_status = :s, status_request_id = :r WHERE id = :i"), {"s": to, "r": req.id, "i": p["id"]})
            log_change(db, cu, p, "Record Status", p["status"], to, reason or "Sent for approval", "", "Pending", request_id=req.id, force=True)
            return {"status": p["status"], "pending": to, "message": f"Sent for approval – {p['code']} moves to {to} once approved"}
        _apply_status(db, cu, p, to, reason or "Approved", _auto_approver(req, cu), "Approved", req.id)
        return {"status": to, "pending": None, "message": f"{p['code']} moved to {to}"}
    _apply_status(db, cu, p, to, reason or ("Submitted for review" if kind == "next" else "Status changed"), "", "Not required", None)
    return {"status": to, "pending": None, "message": f"{p['code']} moved to {to}"}


def _apply_status(db: Session, cu: Optional[User], p: dict, to: str, reason: str, approver: str, approval: str, rid: Optional[int]) -> None:
    db.execute(text("UPDATE products_master SET record_status = :s, pending_status = NULL, status_request_id = NULL, updated_at = :n" + (", updated_by = :u" if cu else "") +
                    " WHERE id = :i"), {"s": to, "n": _now(), "u": cu.id if cu else None, "i": p["id"]})
    for w in db.query(ProductChangeWindow).filter(ProductChangeWindow.product_id == p["id"], ProductChangeWindow.status.in_(("open", "pending"))).all():
        w.status, w.closed_at = "closed", _now()
    log_change(db, cu, p, "Record Status", p["status"], to, reason, approver, approval, request_id=rid, force=True)


def on_decision(db: Session, request_row, actor: User, remarks: str = "") -> None:
    """Approvals engine callback (module "product")."""
    from app.services.product_service import get_product
    status = (request_row.status or "").strip().lower()
    if request_row.action_key == "approve":
        row = db.execute(text("SELECT id, pending_status FROM products_master WHERE status_request_id = :r"), {"r": request_row.id}).first()
        if not row or not row[1]:
            return
        p = get_product(db, row[0])
        if status == "approved":
            _apply_status(db, None, p, row[1], remarks or "Approved", actor.full_name, "Approved", request_row.id)
            db.execute(text("UPDATE products_master SET updated_by = :u WHERE id = :i"), {"u": actor.id, "i": p["id"]})
        elif status == "rejected":
            db.execute(text("UPDATE products_master SET pending_status = NULL, status_request_id = NULL WHERE id = :i"), {"i": p["id"]})
            db.add(ProductChangeLog(product_id=p["id"], product_code=p["code"], product_name=p["name"], field="Record Status", old_value=p["status"],
                                    new_value=f"{row[1]} (rejected)", reason=remarks or "Rejected", changed_by=actor.id, approver_name=actor.full_name,
                                    approval_status="Rejected", approval_request_id=request_row.id))
    elif request_row.action_key == "change":
        w = db.query(ProductChangeWindow).filter(ProductChangeWindow.approval_request_id == request_row.id).first()
        if not w or w.status != "pending":
            return
        p = get_product(db, w.product_id)
        if status == "approved":
            w.status, w.approver_name = "open", actor.full_name
            db.add(ProductChangeLog(product_id=p["id"], product_code=p["code"], product_name=p["name"], field="Change window", old_value="Requested", new_value="Opened",
                                    reason=w.reason, changed_by=actor.id, approver_name=actor.full_name, approval_status="Approved", approval_request_id=request_row.id))
        elif status == "rejected":
            w.status, w.closed_at = "rejected", _now()
            db.add(ProductChangeLog(product_id=p["id"], product_code=p["code"], product_name=p["name"], field="Change window", old_value="Requested", new_value="Rejected",
                                    reason=remarks or w.reason, changed_by=actor.id, approver_name=actor.full_name, approval_status="Rejected", approval_request_id=request_row.id))


def record_label(db: Session, request_row) -> str:
    if request_row.action_key == "change":
        w = db.query(ProductChangeWindow).filter(ProductChangeWindow.id == request_row.record_id).first()
        r = db.execute(text("SELECT sku, name FROM products_master WHERE id = :i"), {"i": w.product_id}).first() if w else None
        return f"Product change: {r[0]} – {r[1]}" if r else f"Product change #{request_row.record_id}"
    r = db.execute(text("SELECT sku, name, pending_status FROM products_master WHERE id = :i"), {"i": request_row.record_id}).first()
    return f"Product: {r[0]} – {r[1]}" + (f" → {r[2]}" if r and r[2] else "") if r else f"Product #{request_row.record_id}"


# ─── category map (matrix) ────────────────────────────────────────────────────

def matrix(db: Session, show_internal: bool) -> dict[str, Any]:
    from app.services.product_service import products
    m = ensure_model(db)
    st = statuses(db)
    final = st[-1].name if st else None
    P = [p for p in products(db) if p["status"] != final]
    ids = {p["id"] for p in P}
    maps = [x for x in mappings(db) if x["product_id"] in ids]
    cats = [c for c in categories(db) if show_internal or not c.is_internal]
    byp = {p["id"]: p for p in P}
    cells: dict[str, list] = {}
    for x in maps:
        p = byp[x["product_id"]]
        cells.setdefault(f"{x['stage_id']}:{x['category_id']}", []).append({"id": p["id"], "code": p["code"], "name": p["name"], "role": x["role"], "rm": x["rm"]})
    mapped = {x["product_id"] for x in maps}
    return {"model": m.name, "grouping": m.grouping, "active": len(P), "has_internal": any(c.is_internal for c in categories(db)),
            "categories": [{"id": c.id, "name": c.name, "internal": bool(c.is_internal), "products": len({x["product_id"] for x in maps if x["category_id"] == c.id})} for c in cats],
            "stages": [{"id": s.id, "name": s.name} for s in stages(db)], "cells": cells,
            "unmapped": [{"id": p["id"], "code": p["code"], "name": p["name"]} for p in P if p["id"] not in mapped]}


# ─── Excel: Product Master workbook ───────────────────────────────────────────

def _field_value_for_sheet(p: dict, f: ProductField) -> Any:
    v = p["fields"].get(f.field_key)
    if f.field_key == "oem":
        return p.get("oem") or ""
    return "" if v is None else v


def workbook(db: Session, company: str, include_products: bool = True) -> bytes:
    """Product Master workbook built from the company's model: Product Master (enabled fields, * = required, list
    validation), Category Mapping, Specifications, Lists & Guidance and Change Log."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation
    from app.services.product_service import lookups, products
    m = ensure_model(db)
    F = [f for f in fields(db) if f.is_on or f.field_key in ALWAYS]
    P = products(db) if include_products else []
    maps = mappings(db) if include_products else []
    cats, sts, stg = categories(db), statuses(db), stages(db)
    oems = [o["name"] for o in lookups(db)["oems"]]
    wb = Workbook()
    hfill, hfont = PatternFill("solid", fgColor="DDEBF7"), Font(bold=True)
    req_font = Font(bold=True, color="C00000")

    def head(ws, cols, req=()):
        ws.append(cols)
        for i, c in enumerate(cols, 1):
            cell = ws.cell(row=1, column=i)
            cell.fill, cell.font = hfill, (req_font if c in req else hfont)
            ws.column_dimensions[get_column_letter(i)].width = max(14, min(42, len(c) + 4))
        ws.freeze_panes = "A2"

    # Lists & Guidance first (validation ranges point here), moved to the end afterwards
    lists = wb.active
    lists.title = "Lists & Guidance"
    cols = {"PRODUCT CATEGORIES": [c.name for c in cats], "RECORD STATUS": [s.name for s in sts], f"{m.grouping.upper()}S": [s.name for s in stg],
            "MAPPING ROLE": list(m.roles or []), "UNITS": list(m.units or []), "PRINCIPAL / OEM": oems, "AVAILABILITY": AVAILABILITY}
    head(lists, list(cols.keys()) + ["", "FIELD", "CONTENT GUIDANCE"])
    guide = [(f.label + (" *" if (f.is_required or f.field_key in ALWAYS) else ""), f.help or "") for f in F if f.help] + [
        ("Required fields", "Columns marked * must be filled for every product row."),
        ("Product Code", "Leave empty to generate a code from the configured format " + (m.code_format or "") + "; existing codes update that product."),
        ("Specifications", "Maintain detailed rows in the Specifications sheet using the five-column structure."),
        ("Category Mapping", f"One row per product and category where it is used, with {m.grouping.lower()} and role. Exactly one Primary row per product."),
        ("Change Log", f"Read-only history. Changes to {lock_status(db)} records need a change window in the application.")]
    n = max([len(v) for v in cols.values()] + [len(guide)])
    keys = list(cols.keys())
    for i in range(n):
        lists.append([cols[k][i] if i < len(cols[k]) else "" for k in keys] + ["", guide[i][0] if i < len(guide) else "", guide[i][1] if i < len(guide) else ""])
    rng = {k: f"'Lists & Guidance'!${get_column_letter(j + 1)}$2:${get_column_letter(j + 1)}${max(2, len(cols[k]) + 1)}" for j, k in enumerate(keys)}

    pm = wb.create_sheet("Product Master", 0)
    labels = [f.label + (" *" if (f.is_required or f.field_key in ALWAYS) and f.field_key != "code" else "") for f in F]
    head(pm, labels, req=[x for x in labels if x.endswith(" *")])
    for p in P:
        pm.append([_field_value_for_sheet(p, f) for f in F])
    last = max(len(P) + 200, 500)
    for i, f in enumerate(F, 1):
        col = get_column_letter(i)
        src = {"cat": rng["PRODUCT CATEGORIES"], "status": rng["RECORD STATUS"], "unit": rng["UNITS"], "oem": rng["PRINCIPAL / OEM"] if oems else None,
               "stock": rng["AVAILABILITY"]}.get(f.field_key)
        if f.field_type == "sel" and f.field_key != "stock" and f.options:
            src = '"' + ",".join(str(o).replace(",", " ") for o in f.options)[:250] + '"'
        if src:
            dv = DataValidation(type="list", formula1=src if src.startswith('"') else f"={src}", allow_blank=not (f.is_required or f.field_key in ALWAYS))
            dv.error, dv.errorTitle = f"Choose a value from the {f.label} list", f.label
            pm.add_data_validation(dv)
            dv.add(f"{col}2:{col}{last}")
        elif f.field_type in ("cur", "num"):
            dv = DataValidation(type="decimal", operator="greaterThanOrEqual", formula1="0", allow_blank=True)
            dv.error, dv.errorTitle = f"{f.label} must be a number of 0 or more", f.label
            pm.add_data_validation(dv)
            dv.add(f"{col}2:{col}{last}")
        if f.field_type == "ta":
            pm.column_dimensions[col].width = 48
            for r in range(2, len(P) + 2):
                pm.cell(row=r, column=i).alignment = Alignment(wrap_text=True, vertical="top")

    cm = wb.create_sheet("Category Mapping", 1)
    head(cm, ["Product Code *", "Product Description", "Category *", f"{m.grouping} *", "Role *", "Remarks"], req=["Product Code *", "Category *", f"{m.grouping} *", "Role *"])
    byid = {p["id"]: p for p in P}
    for x in maps:
        p = byid.get(x["product_id"])
        if p:
            cm.append([p["code"], p["name"], x["cat"], x["stage"], x["role"], x["rm"]])
    for col, key in (("C", "PRODUCT CATEGORIES"), ("D", f"{m.grouping.upper()}S"), ("E", "MAPPING ROLE")):
        dv = DataValidation(type="list", formula1=f"={rng[key]}", allow_blank=False)
        cm.add_data_validation(dv)
        dv.add(f"{col}2:{col}{last}")

    sp = wb.create_sheet("Specifications", 2)
    head(sp, ["Product Code *", "Parameter *", "Value / Range *", "Unit", "Standard / Material", "Remarks / Options"], req=["Product Code *", "Parameter *", "Value / Range *"])
    if P:
        allspecs = db.query(ProductSpec).filter(ProductSpec.product_id.in_([p["id"] for p in P])).order_by(ProductSpec.product_id, ProductSpec.sort_order).all()
        for s in allspecs:
            p = byid.get(s.product_id)
            if p:
                sp.append([p["code"], s.parameter, s.value or "", s.unit or "", s.standard or "", s.remarks or ""])

    lg = wb.create_sheet("Change Log")
    head(lg, ["Date", "Product Code", "Sheet / Field", "Previous Value", "New Value", "Reason for Change", "Changed By", "Approved By", "Approval"])
    if include_products:
        for r in change_log(db, limit=5000):
            lg.append([(r["date"] or "")[:16].replace("T", " "), r["code"], r["field"], r["old"], r["new"], r["reason"], r["by"], r["approver"], r["approval"]])
    wb.move_sheet("Lists & Guidance", offset=len(wb.sheetnames))
    wb.properties.title = f"Product Master – {company}"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _nk(s: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def _read_sheet(ws) -> list[dict[str, Any]]:
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []
    hdr = [str(h or "").replace("*", "").strip() for h in rows[0]]
    out = []
    for i, r in enumerate(rows[1:], start=2):
        if r is None or all(v in (None, "") for v in r):
            continue
        d = {hdr[j]: r[j] for j in range(min(len(hdr), len(r))) if hdr[j]}
        d["__row"] = i
        out.append(d)
    return out


def _pick(row: dict, *names: str) -> str:
    for n in names:
        nn = _nk(n)
        for k, v in row.items():
            if k != "__row" and _nk(k) == nn and v not in (None, ""):
                return str(v).strip() if not isinstance(v, float) or not v.is_integer() else str(int(v))
    for n in names:
        nn = _nk(n)
        for k, v in row.items():
            if k != "__row" and nn and _nk(k).startswith(nn) and v not in (None, ""):
                return str(v).strip() if not isinstance(v, float) or not v.is_integer() else str(int(v))
    return ""


def parse_import(db: Session, content: bytes, filename: str) -> dict[str, Any]:
    """Validate a Product Master workbook row by row. Nothing is saved here – the result is the import preview."""
    from openpyxl import load_workbook
    from app.services.product_service import lookups, products
    if not (filename or "").lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(422, "Upload the Product Master workbook as .xlsx (download the template first)")
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception:
        raise HTTPException(422, "The file could not be read as an Excel workbook")
    sheets = {_nk(n): wb[n] for n in wb.sheetnames}
    if "productmaster" not in sheets:
        raise HTTPException(422, "The workbook needs a “Product Master” sheet – download the template")
    m = ensure_model(db)
    F = [f for f in fields(db) if f.is_on or f.field_key in ALWAYS]
    pm, mp, sp = _read_sheet(sheets["productmaster"]), _read_sheet(sheets["categorymapping"]) if "categorymapping" in sheets else [], \
        _read_sheet(sheets["specifications"]) if "specifications" in sheets else []
    cats = {c.name.lower(): c for c in categories(db)}
    stg = {s.name.lower(): s for s in stages(db)}
    st = [s.name for s in statuses(db)]
    units = {u.lower(): u for u in (m.units or [])}
    oems = {o["name"].strip().lower(): o["id"] for o in lookups(db)["oems"]}
    existing = {p["code"].lower(): p for p in products(db)}
    lock = lock_status(db)
    roles = list(m.roles or ["Primary", "Supporting"])
    out, seen = [], set()
    for r in pm:
        e: list[str] = []
        w: list[str] = []
        vals: dict[str, Any] = {}
        for f in F:
            alias = {"code": ("Product Code", "Code", "SKU"), "name": ("Product Description", "Product name", "Product / service", "Name"),
                     "cat": ("Product Category", "Category"), "longDesc": ("Product Long Description", "Long description"), "coo": ("COO", "Country of origin"),
                     "status": ("Record Status", "Status"), "oem": ("Principal / OEM", "OEM", "Principal / make", "Principal")}.get(f.field_key, ())
            vals[f.field_key] = _pick(r, f.label, *alias)
        code = vals.get("code", "")
        if code and len(code) > 40:
            e.append("Product Code is longer than 40 characters")
        if code and code.lower() in seen:
            e.append(f"Product Code {code} is repeated in the file")
        seen.add(code.lower()) if code else None
        cur = existing.get(code.lower()) if code else None
        name = vals.get("name", "")
        if not name:
            e.append("Product Description (name) is required")
        elif len(name) > 300:
            e.append("Product Description is longer than 300 characters")
        cat = vals.get("cat", "")
        if cat and cat.lower() not in cats:
            e.append(f"Category “{cat}” is not a configured category")
        elif cat:
            vals["cat"] = cats[cat.lower()].name
        unit = vals.get("unit", "")
        if unit and unit.lower() not in units:
            e.append(f"Unit “{unit}” is not a configured unit")
        elif unit:
            vals["unit"] = units[unit.lower()]
        for k, lbl in (("list", "List price"), ("cost", "Standard cost"), ("gst", "GST %")):
            v = vals.get(k, "")
            if v:
                try:
                    d = Decimal(v.replace(",", ""))
                    if d < 0:
                        e.append(f"{lbl} must be zero or more")
                    if k == "gst" and d > 100:
                        e.append("GST % must be 0–100")
                except Exception:
                    e.append(f"{lbl} “{v}” is not a number")
        oem = vals.get("oem", "")
        if oem and oem.lower() not in oems:
            e.append(f"Principal / OEM “{oem}” is not in Partners & OEM")
        stock = vals.get("stock", "")
        if stock and stock not in AVAILABILITY:
            e.append(f"Availability must be one of {', '.join(AVAILABILITY)}")
        coo = vals.get("coo", "")
        if coo and len(coo) > 80:
            e.append("COO is longer than 80 characters")
        status = vals.get("status", "")
        if status and status not in st:
            e.append(f"Record Status “{status}” is not configured")
        if cur and status and status != cur["status"]:
            e.append("Record Status cannot be changed by import – use the lifecycle actions on the product")
        if not cur and status and status != st[0]:
            w.append(f"New products start as {st[0]} – “{status}” is ignored")
        for f in F:
            if f.is_required and f.field_key not in ("code", "status") and not vals.get(f.field_key):
                e.append(f"{f.label} is required")
            if f.field_type == "sel" and f.options and vals.get(f.field_key) and f.field_key != "stock" and vals[f.field_key] not in f.options:
                e.append(f"{f.label} must be one of {', '.join(f.options)}")
            if f.field_type == "num" and f.field_key not in ("gst",) and vals.get(f.field_key):
                try:
                    float(vals[f.field_key].replace(",", ""))
                except ValueError:
                    e.append(f"{f.label} must be a number")
        diff = []
        if cur:
            for f in F:
                k = f.field_key
                if k in ("code", "status"):
                    continue
                a = cur["oem"] if k == "oem" else cur["fields"].get(k)
                b = vals.get(k, "")
                if f.field_type in ("cur", "num") and a not in (None, "") and b not in (None, ""):
                    try:
                        if float(str(a)) == float(str(b).replace(",", "")):
                            continue
                    except ValueError:
                        pass
                if str(a if a is not None else "").strip() != str(b).strip():
                    diff.append(f.label)
        if cur and not diff:
            e = [x for x in e if "is required" not in x]      # nothing changes – the row is left as it is
        if cur and diff and cur["status"] == lock:
            e.append(f"{cur['code']} is {lock} – changes ({', '.join(diff[:3])}) need a change window in the application, not an import")
        if cur and diff and cur.get("pending_status"):
            e.append(f"{cur['code']} is waiting for approval")
        if name and not cur:
            dup = next((p for p in existing.values() if p["name"].strip().lower() == name.lower()), None)
            if dup:
                w.append(f"A product named “{name}” already exists ({dup['code']}) – a second product will be created")
        out.append({"row": r["__row"], "code": code, "name": name, "category": vals.get("cat", ""), "status": (cur["status"] if cur else st[0]),
                    "action": ("update" if diff else "unchanged") if cur else "add", "changes": diff, "errors": e, "warnings": w, "values": vals,
                    "product_id": cur["id"] if cur else None})
    codes = {o["code"].lower() for o in out if o["code"]} | set(existing)
    mrows, srows = [], []
    for r in mp:
        e = []
        code, cat, stage, role = _pick(r, "Product Code"), _pick(r, "Category"), _pick(r, m.grouping, "Process Stage", "Stage"), _pick(r, "Role")
        if not code or code.lower() not in codes:
            e.append(f"Product Code “{code}” is not in the Product Master sheet or the catalogue")
        if cat.lower() not in cats:
            e.append(f"Category “{cat}” is not configured")
        if stage.lower() not in stg:
            e.append(f"{m.grouping} “{stage}” is not configured")
        if role not in roles:
            e.append(f"Role must be one of {', '.join(roles)}")
        mrows.append({"row": r["__row"], "code": code, "cat": cats[cat.lower()].name if cat.lower() in cats else cat, "stage": stg[stage.lower()].name if stage.lower() in stg else stage,
                      "role": role, "rm": _pick(r, "Remarks")[:500], "errors": e})
    pairs: dict[str, set] = {}
    for x in mrows:
        k = (x["cat"].lower(), x["stage"].lower())
        if k in pairs.setdefault(x["code"].lower(), set()):
            x["errors"].append(f"{x['cat']} · {x['stage']} is mapped twice for {x['code']}")
        pairs[x["code"].lower()].add(k)
    for x in out:
        if x["code"] and any(m_["code"].lower() == x["code"].lower() for m_ in mrows):
            prim = sum(1 for m_ in mrows if m_["code"].lower() == x["code"].lower() and m_["role"] == "Primary")
            if prim != 1:
                x["warnings"].append(f"needs exactly one Primary mapping (has {prim})")
    for r in sp:
        e = []
        code, par, val = _pick(r, "Product Code"), _pick(r, "Parameter"), _pick(r, "Value / Range", "Value")
        if not code or code.lower() not in codes:
            e.append(f"Product Code “{code}” is not in the Product Master sheet or the catalogue")
        if not par:
            e.append("Parameter is required")
        if not val:
            e.append("Value / Range is required")
        srows.append({"row": r["__row"], "code": code, "p": par[:200], "v": val[:300], "u": _pick(r, "Unit")[:60], "std": _pick(r, "Standard / Material", "Standard")[:300],
                      "rm": _pick(r, "Remarks / Options", "Remarks")[:500], "errors": e})
    # mappings / specs that would change an approved (locked) product need a change window, not an import
    locked = {p["code"].lower(): p for p in existing.values() if p["status"] == lock or p.get("pending_status")}
    if locked:
        cur_m: dict[int, set] = {}
        for x in mappings(db):
            cur_m.setdefault(x["product_id"], set()).add((x["cat"].lower(), x["stage"].lower(), x["role"], x["rm"]))
        cur_s: dict[int, list] = {}
        for s in db.query(ProductSpec).filter(ProductSpec.product_id.in_([p["id"] for p in locked.values()])).order_by(ProductSpec.sort_order, ProductSpec.id).all():
            cur_s.setdefault(s.product_id, []).append((s.parameter, s.value or "", s.unit or "", s.standard or "", s.remarks or ""))
        for code, p in locked.items():
            fm = {(x["cat"].lower(), x["stage"].lower(), x["role"], x["rm"]) for x in mrows if x["code"].lower() == code}
            if any(x["code"].lower() == code for x in mrows) and fm != cur_m.get(p["id"], set()):
                for x in mrows:
                    if x["code"].lower() == code:
                        x["errors"].append(f"{p['code']} is {p['status']} – its category mapping can only change through a change window")
            fs = [(x["p"], x["v"], x["u"], x["std"], x["rm"]) for x in srows if x["code"].lower() == code]
            if fs and fs != cur_s.get(p["id"], []):
                for x in srows:
                    if x["code"].lower() == code:
                        x["errors"].append(f"{p['code']} is {p['status']} – its specifications can only change through a change window")
    for x in mrows:
        x["skip"] = x["code"].lower() in locked
    for x in srows:
        x["skip"] = x["code"].lower() in locked
    errs = sum(1 for x in out if x["errors"]) + sum(1 for x in mrows if x["errors"]) + sum(1 for x in srows if x["errors"])
    return {"file": filename, "products": out, "mappings": mrows, "specs": srows, "add": sum(1 for x in out if x["action"] == "add" and not x["errors"]),
            "update": sum(1 for x in out if x["action"] == "update" and not x["errors"]), "unchanged": sum(1 for x in out if x["action"] == "unchanged" and not x["errors"]),
            "error_rows": errs, "ok": bool(out) and errs == 0}


def commit_import(db: Session, cu: User, request: Optional[Request], prev: dict[str, Any]) -> dict[str, int]:
    """Apply a validated preview (all rows valid). Creates / updates products and replaces the mappings and
    specifications given for a product; every change is written to the change log as a template import."""
    from app.services.product_service import create, get_product, lookups, update
    if not prev["ok"]:
        raise HTTPException(422, f"The workbook has {prev['error_rows']} row(s) with errors – fix them and upload again. Nothing was imported.")
    oems = {o["name"].strip().lower(): o["id"] for o in lookups(db)["oems"]}
    added = updated = 0
    ids: dict[str, int] = {}
    for x in prev["products"]:
        if x["action"] == "unchanged":
            ids[x["code"].lower()] = x["product_id"]
            continue
        v = x["values"]
        body: dict[str, Any] = {k: v.get(k) or None for k in v if k not in ("status",)}
        body["oem"] = oems.get((v.get("oem") or "").lower()) if v.get("oem") else None
        if x["action"] == "add":
            res = create(db, cu, request, body, reason=f"Template import ({prev['file']})")
            ids[res["code"].lower()] = res["id"]
            added += 1
        else:
            update(db, cu, request, x["product_id"], {k: val for k, val in body.items() if val not in (None, "")}, partial=True, reason=f"Template import ({prev['file']})")
            ids[x["code"].lower()] = x["product_id"]
            updated += 1
    existing = {r[1].lower(): r[0] for r in db.execute(text("SELECT id, sku FROM products_master WHERE (is_active = 1 OR is_active IS NULL) AND sku IS NOT NULL")).all()}
    cats = {c.name: c.id for c in categories(db)}
    stg = {s.name: s.id for s in stages(db)}
    by_code_m: dict[str, list] = {}
    for x in prev["mappings"]:
        if not x.get("skip"):
            by_code_m.setdefault(x["code"].lower(), []).append({"category_id": cats[x["cat"]], "stage_id": stg[x["stage"]], "role": x["role"], "rm": x["rm"]})
    by_code_s: dict[str, list] = {}
    for x in prev["specs"]:
        if not x.get("skip"):
            by_code_s.setdefault(x["code"].lower(), []).append({"p": x["p"], "v": x["v"], "u": x["u"], "std": x["std"], "rm": x["rm"]})
    for code in set(by_code_m) | set(by_code_s):
        pid = ids.get(code) or existing.get(code)
        if not pid:
            continue
        p = get_product(db, pid)
        ctx = edit_context(db, p)
        ctx["reason"] = f"Template import ({prev['file']})"
        if code in by_code_m:
            save_mappings(db, cu, p, by_code_m[code], ctx)
        if code in by_code_s:
            save_specs(db, cu, p, by_code_s[code], ctx)
    return {"added": added, "updated": updated, "mappings": len(prev["mappings"]), "specs": len(prev["specs"])}
