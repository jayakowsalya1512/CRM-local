"""Product & Price Books (prototype v18 · Sales → Product & Price Books): catalogue, pricing, price books, approvals.

* Catalogue = active rows of ``products_master`` (the shared product master). Extra catalogue columns are added here
  with additive ALTERs and read with explicit SQL, so the ProductMaster ORM model used by other modules is untouched.
  Principal / OEM = Partners & OEM (``oems``): products_master.oem_id, else the OEM whose legacy product_id points here.
* Fields, categories, units, record statuses and rules come from the company product model (product_model_service).
* Margin % = (List price − Std cost) / List price × 100 (prototype pxMg, rounded); 0 when there is no list price.
* Price books: Book price = List price × (1 + adjustment % / 100), converted to the book currency with the book's
  exchange rate (base-currency units per 1 book-currency unit); a product override (fixed book price) wins.
  Book margin % = (Book price − Std cost) / Book price × 100. Floor = Std cost × (1 + minimum margin % / 100).
* Discounts deeper than the configured discount limit go through the approval engine (module "price_book": action
  "discount" for a book adjustment, "override" for a product override). Book prices below the floor follow the
  company's below-floor policy (Warn / Block / Approval).
* Every product / price-book change is written to the append-only change log (product_change_log).
* Permissions: products.view / create / update / delete / export; configuration needs settings.manage.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import threading
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.core.timezone import now_ist
from app.dependencies import get_request_ip
from app.models.all_models import ActivityLog, Setting, User
from app.models.products import PRODUCT_TABLES, PriceBook, PriceBookItem, ProductCategoryMap, ProductNote, ProductPriceHistory, ProductSpec
from app.services import product_model_service as PM

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

MODULE = "products"
AVAILABILITY = PM.AVAILABILITY
D0, C2 = Decimal("0"), Decimal("0.01")
BOOK_TYPES = ["Standard", "Customer contract", "Rate contract", "Segment", "Channel", "Scheme", "Export"]
BOOK_STATUSES = ["Draft", "Active", "Expired"]
SETTING_LABELS = {"product_units": "Units of measurement", "price_book_currencies": "Price book currencies", "product_sku_prefix": "SKU prefix",
                  "price_book_approval_limit": "Price book discount needing approval (%)"}
CFG_SEED = {"product_units": json.dumps(["Nos", "Set", "Lot", "Km", "Mtr", "Hrs"]), "product_sku_prefix": "SKU-", "price_book_approval_limit": "15"}


def q2(v: Decimal) -> Decimal:
    return v.quantize(C2, rounding=ROUND_HALF_UP)


def dec(v: Any, label: str = "value") -> Optional[Decimal]:
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        return Decimal(str(v).replace(",", "").strip())
    except Exception:
        raise HTTPException(422, f"{label} must be a number")


# ─── schema ───────────────────────────────────────────────────────────────────

PRODUCT_COLUMNS = [
    ("sku", "VARCHAR(40) NULL"), ("oem_id", "INT NULL"), ("unit", "VARCHAR(30) NULL"), ("list_price", "DECIMAL(15,2) NULL"),
    ("std_cost", "DECIMAL(15,2) NULL"), ("gst_percent", "DECIMAL(5,2) NULL"), ("availability", "VARCHAR(30) NULL"),
    ("custom_data", "JSON NULL"), ("created_by", "INT NULL"), ("updated_by", "INT NULL"), ("updated_at", "DATETIME NULL"),
    # prototype v18 Product Master fields
    ("record_status", "VARCHAR(60) NULL"), ("pending_status", "VARCHAR(60) NULL"), ("status_request_id", "INT NULL"), ("features", "TEXT NULL"),
    ("coo", "VARCHAR(80) NULL"), ("usage_policy", "TEXT NULL"), ("usage_guide", "TEXT NULL"), ("supply_req", "TEXT NULL"), ("model_data", "JSON NULL"),
]
BOOK_COLUMNS = [("book_type", "VARCHAR(30) NULL"), ("valid_from", "DATE NULL"), ("valid_to", "DATE NULL"), ("applies_to", "VARCHAR(300) NULL"),
                ("book_status", "VARCHAR(20) NOT NULL DEFAULT 'Active'")]


def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        db.execute(text("ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `is_active` TINYINT(1) NOT NULL DEFAULT 1"))
        for col, ddl in PRODUCT_COLUMNS:
            db.execute(text(f"ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `{col}` {ddl}"))
        db.execute(text("CREATE INDEX IF NOT EXISTS ix_products_master_sku ON products_master (sku)"))
        db.execute(text("CREATE INDEX IF NOT EXISTS ix_products_master_record_status ON products_master (record_status)"))
        # The Approvals engine (record approvals, change windows, price-book discounts) loads OrgTreeNode, whose ORM model
        # has a description column that admin360 only adds when Teams & Territories is first opened.
        db.execute(text("ALTER TABLE org_tree_nodes ADD COLUMN IF NOT EXISTS description VARCHAR(500) NULL"))
        db.commit()
        for t in PRODUCT_TABLES:
            t.create(bind=db.get_bind(), checkfirst=True)
        db.commit()
        for col, ddl in BOOK_COLUMNS:
            db.execute(text(f"ALTER TABLE price_books ADD COLUMN IF NOT EXISTS `{col}` {ddl}"))
        db.commit()
        for k, v in CFG_SEED.items():
            if not db.query(Setting.id).filter(Setting.key == k).first():
                db.add(Setting(key=k, value=v, type="number" if k.endswith("limit") else "json" if k == "product_units" else "string", category="products",
                               label=SETTING_LABELS[k]))
        base = base_currency(db)
        if not db.query(Setting.id).filter(Setting.key == "price_book_currencies").first():
            db.add(Setting(key="price_book_currencies", value=json.dumps([base] + (["USD"] if base != "USD" else [])), type="json", category="products",
                           label="Price book currencies"))
        db.commit()
        _backfill_skus(db)
        PM.ensure_model(db)
        db.commit()
        if not db.query(PriceBook.id).first():
            db.add(PriceBook(name="Standard list", currency=base, adjustment=0, all_products=True, is_default=True, sort_order=0, status="active"))
            db.commit()
        # v17 price books (created before types / validity existed) get a type from their currency
        db.execute(text("UPDATE price_books SET book_type = CASE WHEN is_default = 1 THEN 'Standard' WHEN currency <> :b THEN 'Export' ELSE 'Segment' END "
                        "WHERE book_type IS NULL"), {"b": base})
        db.execute(text("UPDATE price_books SET valid_from = DATE(created_at) WHERE valid_from IS NULL"))
        db.execute(text("UPDATE price_books SET applies_to = 'All customers' WHERE applies_to IS NULL AND is_default = 1"))
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
            logger.warning("products schema: tenant %s unavailable: %s", slug, exc)
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
        except Exception as exc:
            logger.warning("products schema for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()


def _backfill_skus(db: Session) -> None:
    """Products created before the catalogue had codes get one from the v17 series (prefix + 1000 + n)."""
    rows = db.execute(text("SELECT id FROM products_master WHERE sku IS NULL OR sku = '' ORDER BY id")).all()
    if not rows:
        return
    prefix = (setting(db, "product_sku_prefix") or "SKU-").strip() or "SKU-"
    for (pid,) in rows:
        n = db.execute(text("SELECT MAX(CAST(SUBSTRING(sku, :o) AS UNSIGNED)) FROM products_master WHERE sku LIKE :p AND SUBSTRING(sku, :o) REGEXP '^[0-9]+$'"),
                       {"o": len(prefix) + 1, "p": f"{prefix}%"}).scalar()
        db.execute(text("UPDATE products_master SET sku = :s WHERE id = :i"), {"s": f"{prefix}{max(int(n or 0) + 1, 1000)}", "i": pid})
        db.flush()
    db.commit()


# ─── settings ─────────────────────────────────────────────────────────────────

def setting(db: Session, key: str) -> Optional[str]:
    return db.query(Setting.value).filter(Setting.key == key).scalar()


def base_currency(db: Session) -> str:
    return ((setting(db, "currency") or "INR").strip() or "INR").upper()


def _json_list(v: Optional[str]) -> list[str]:
    try:
        x = json.loads(v or "[]")
        return [str(i).strip() for i in x if str(i).strip()] if isinstance(x, list) else []
    except ValueError:
        return []


def currencies(db: Session) -> list[str]:
    base = base_currency(db)
    return [base] + [c for c in _json_list(setting(db, "price_book_currencies")) if c != base]


def config(db: Session) -> dict[str, Any]:
    r = PM.rules(db)
    return {"units": list(PM.ensure_model(db).units or []), "currencies": currencies(db), "base_currency": base_currency(db),
            "approval_limit": r["discLimit"], "min_margin": r["minMargin"], "floor_policy": r["floorPolicy"]}


def save_currencies(db: Session, cu: User, items: list[str]) -> dict[str, Any]:
    c: list[str] = []
    for x in items or []:
        s = str(x).strip().upper()
        if not s:
            continue
        if not (s.isalpha() and len(s) == 3):
            raise HTTPException(422, f"“{x}” is not a 3-letter currency code (e.g. USD)")
        if s not in c:
            c.append(s)
    used = {u for (u,) in db.execute(text("SELECT DISTINCT currency FROM price_books WHERE is_active = 1")).all()}
    gone = sorted(u for u in used if u not in c and u != base_currency(db))
    if gone:
        raise HTTPException(409, f"{gone[0]} is used by a price book – change that book first")
    _put_setting(db, cu, "price_book_currencies", json.dumps(c), "json")
    db.flush()
    return config(db)


def _put_setting(db: Session, cu: User, key: str, value: str, typ: str) -> None:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row is None:
        row = Setting(key=key, value=value, type=typ, category="products", label=SETTING_LABELS.get(key, key))
        db.add(row)
    row.value = value
    row.updated_by = cu.id


# ─── catalogue ────────────────────────────────────────────────────────────────

SELECT = ("SELECT p.id, p.sku, p.name, p.category, p.description, p.unit, p.list_price, p.std_cost, p.gst_percent, p.availability, p.oem_id, "
          "p.custom_data, p.created_at, p.updated_at, p.created_by, p.updated_by, p.record_status, p.pending_status, p.features, p.coo, p.usage_policy, "
          "p.usage_guide, p.supply_req, p.model_data, "
          "COALESCE(o.name, (SELECT o2.name FROM oems o2 WHERE o2.product_id = p.id AND (o2.is_deleted = 0 OR o2.is_deleted IS NULL) ORDER BY o2.id LIMIT 1)) AS oem "
          "FROM products_master p LEFT JOIN oems o ON o.id = p.oem_id ")


def margin(list_price: Any, cost: Any) -> int:
    """prototype pxMg(): round((1 − cost / list) × 100); 0 without a list price."""
    lp, c = Decimal(str(list_price or 0)), Decimal(str(cost or 0))
    if not lp:
        return 0
    return int(((Decimal(1) - c / lp) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _js(v: Any) -> dict:
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            v = None
    return v if isinstance(v, dict) else {}


def row_out(r) -> dict[str, Any]:
    lp = float(r["list_price"]) if r["list_price"] is not None else None
    sc = float(r["std_cost"]) if r["std_cost"] is not None else None
    x = _js(r["model_data"])
    f = {"code": r["sku"] or f"#{r['id']}", "name": r["name"], "cat": r["category"] or "", "longDesc": r["description"] or "", "features": r["features"] or "",
         "coo": r["coo"] or "", "policy": r["usage_policy"] or "", "guide": r["usage_guide"] or "", "supply": r["supply_req"] or "", "status": r["record_status"] or "",
         "unit": r["unit"] or "", "list": lp, "cost": sc, "oem": r["oem_id"], "stock": r["availability"] or "",
         "gst": float(r["gst_percent"]) if r["gst_percent"] is not None else None, **x}
    return {"id": r["id"], "code": f["code"], "sku": f["code"], "name": r["name"], "cat": f["cat"], "longDesc": f["longDesc"], "features": f["features"],
            "coo": f["coo"], "policy": f["policy"], "guide": f["guide"], "supply": f["supply"], "status": f["status"], "pending_status": r["pending_status"] or None,
            "unit": f["unit"], "list": lp, "cost": sc, "margin": margin(lp, sc), "oem": r["oem"] or "", "oem_id": r["oem_id"], "stock": f["stock"],
            "gst": f["gst"], "x": x, "fields": f, "custom_data": _js(r["custom_data"]),
            "created_at": r["created_at"].isoformat() if r["created_at"] else None, "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            "created_by": r["created_by"], "updated_by": r["updated_by"]}


def products(db: Session, ids: Optional[list[int]] = None) -> list[dict[str, Any]]:
    where = "WHERE (p.is_active = 1 OR p.is_active IS NULL)"
    params: dict[str, Any] = {}
    if ids is not None:
        if not ids:
            return []
        where += " AND p.id IN :ids"
        params["ids"] = ids
    stmt = text(SELECT + where + " ORDER BY p.id DESC")
    if ids is not None:
        stmt = stmt.bindparams(bindparam("ids", expanding=True))
    return [row_out(r) for r in db.execute(stmt, params).mappings().all()]


def get_product(db: Session, pid: int) -> dict[str, Any]:
    rows = products(db, [pid])
    if not rows:
        raise HTTPException(404, "Product not found")
    return rows[0]


def oem_list(db: Session) -> list[dict[str, Any]]:
    return [{"id": i, "name": n, "sub": t or ""} for i, n, t in db.execute(text(
        "SELECT id, name, type FROM oems WHERE (is_active = 1 OR is_active IS NULL) AND (is_deleted = 0 OR is_deleted IS NULL) ORDER BY name")).all()]


def lookups(db: Session) -> dict[str, Any]:
    cfg = config(db)
    return {"categories": [c.name for c in PM.categories(db)], "oems": oem_list(db), "units": cfg["units"], "availability": AVAILABILITY,
            "currencies": cfg["currencies"], "base_currency": cfg["base_currency"], "statuses": [s.name for s in PM.statuses(db)],
            "book_types": BOOK_TYPES, "book_statuses": BOOK_STATUSES}


def _log(db: Session, cu: User, request: Optional[Request], pid: Optional[int], name: str, action: str, desc: str,
         old: Optional[dict] = None, new: Optional[dict] = None, icon: str = "🏷️") -> None:
    from app.core.logging import log_module_action
    if pid:
        db.add(ActivityLog(user_id=cu.id, module=MODULE, record_id=pid, action=action, description=desc, icon=icon, color="#EFF6FF"))
    log_module_action(db=db, user_id=cu.id, module=MODULE, action=action, record_id=pid, record_name=name,
                      ip=get_request_ip(request) if request else "", old_data=old, new_data=new)


def _history(db: Session, cu: User, pid: Optional[int], book: Optional[int], field: str, old: Optional[Decimal], new: Optional[Decimal], note: str = "") -> None:
    if (old is None and new is None) or (old is not None and new is not None and Decimal(old) == Decimal(new)):
        return
    db.add(ProductPriceHistory(product_id=pid, price_book_id=book, field=field, old_value=old, new_value=new, note=note[:300] or None, changed_by=cu.id))


def _txt(v: Any, n: int) -> Optional[str]:
    s = str(v or "").strip()
    return s[:n] if s else None


def validate(db: Session, body: dict[str, Any], current: Optional[dict] = None) -> dict[str, Any]:
    """Product values against the company product model. Returns column values plus model_data (model / custom fields)."""
    F = {f.field_key: f for f in PM.fields(db)}
    lbl = lambda k, d: (F[k].label if k in F else d)
    out: dict[str, Any] = {}
    name = str(body.get("name") or "").strip()
    if len(name) < 2:
        raise HTTPException(422, f"{lbl('name', 'Product name')} is required (at least 2 characters)")
    if len(name) > 300:
        raise HTTPException(422, f"{lbl('name', 'Product name')} is too long (300 characters at most)")
    out["name"] = name
    code = str(body.get("code") or "").strip()
    if current:
        code = current["code"]                                  # codes are controlled identifiers – never changed
    elif code:
        if len(code) > 40 or not all(ch.isalnum() or ch in "-_/." for ch in code):
            raise HTTPException(422, "Product code: up to 40 letters, digits, - _ / .")
        if db.execute(text("SELECT 1 FROM products_master WHERE LOWER(sku) = :c LIMIT 1"), {"c": code.lower()}).first():
            raise HTTPException(409, f"Product code {code} already exists – codes are unique and retired codes are not reused")
    out["sku"] = code or None
    cat = str(body.get("cat") or "").strip()
    cats = [c.name for c in PM.categories(db)]
    if cat and cat not in cats:
        if not (current and cat == current["cat"]):
            raise HTTPException(422, f"Choose a {lbl('cat', 'category').lower()} configured in the product model")
    out["category"] = cat[:100] or None
    unit = str(body.get("unit") or "").strip()
    if unit and unit not in (PM.ensure_model(db).units or []) and not (current and unit == current["unit"]):
        raise HTTPException(422, "Choose a unit configured in the product model")
    out["unit"] = unit or None
    for k, col, d in (("list", "list_price", "List price"), ("cost", "std_cost", "Standard cost")):
        v = dec(body.get(k), lbl(k, d))
        if v is not None and (v < 0 or v >= Decimal("1e13")):
            raise HTTPException(422, f"{lbl(k, d)} must be zero or more")
        out[col] = q2(v) if v is not None else None
    if out["std_cost"] and not out["list_price"]:
        raise HTTPException(422, f"Enter a {lbl('list', 'list price').lower()} above zero so the margin can be calculated")
    g = dec(body.get("gst"), "GST %")
    if g is not None and not D0 <= g <= 100:
        raise HTTPException(422, "GST % must be 0–100")
    out["gst_percent"] = g
    av = str(body.get("stock") or "").strip()
    if av and av not in AVAILABILITY:
        raise HTTPException(422, f"Availability must be one of {', '.join(AVAILABILITY)}")
    out["availability"] = av or None
    oem = body.get("oem")
    if oem not in (None, "", 0):
        try:
            oid = int(oem)
        except (TypeError, ValueError):
            raise HTTPException(422, "Choose a Principal / OEM from Partners & OEM")
        if not db.execute(text("SELECT 1 FROM oems WHERE id = :i AND (is_deleted = 0 OR is_deleted IS NULL)"), {"i": oid}).first():
            raise HTTPException(422, "Choose a Principal / OEM from Partners & OEM")
        out["oem_id"] = oid
    else:
        out["oem_id"] = None
    out["description"] = _txt(body.get("longDesc"), 10000)
    out["features"] = _txt(body.get("features"), 10000)
    out["coo"] = _txt(body.get("coo"), 80)
    out["usage_policy"] = _txt(body.get("policy"), 10000)
    out["usage_guide"] = _txt(body.get("guide"), 10000)
    out["supply_req"] = _txt(body.get("supply"), 10000)
    md = dict((current or {}).get("x") or {})
    for k, f in F.items():
        if f.source not in ("x", "custom") or k not in body:
            continue
        v = body.get(k)
        v = "" if v is None else str(v).strip()
        if v and f.field_type == "num":
            try:
                float(v.replace(",", ""))
            except ValueError:
                raise HTTPException(422, f"{f.label} must be a number")
        if v and f.field_type == "date":
            try:
                dt.date.fromisoformat(v[:10])
            except ValueError:
                raise HTTPException(422, f"{f.label} must be a date")
        if v and f.field_type == "sel" and f.options and v not in f.options:
            raise HTTPException(422, f"{f.label} must be one of {', '.join(f.options)}")
        md[k] = v[:2000]
    out["model_data"] = json.dumps(md) if md else None
    # required fields of the product model
    col_of = {**PM.FIELD_COL}
    miss = []
    for k, f in F.items():
        if not (f.is_on and f.is_required) or k in ("code", "status"):
            continue
        v = md.get(k) if f.source in ("x", "custom") else out.get(col_of.get(k, ""))
        if v in (None, "") or (isinstance(v, str) and not v.strip()):
            miss.append(f.label)
    if miss:
        raise HTTPException(422, "Required: " + ", ".join(miss))
    return out


COLS = ["sku", "name", "category", "description", "oem_id", "unit", "list_price", "std_cost", "gst_percent", "availability", "features", "coo", "usage_policy",
        "usage_guide", "supply_req", "model_data"]


def create(db: Session, cu: User, request: Optional[Request], body: dict[str, Any], reason: str = "New product") -> dict[str, Any]:
    v = validate(db, body)
    m = PM.ensure_model(db)
    first = PM.statuses(db)[0].name
    v["sku"] = v["sku"] or PM.next_code(db, v["category"] or "", v["name"])
    v.update({"cb": cu.id, "now": now_ist(), "st": first})
    db.execute(text(f"INSERT INTO products_master ({', '.join(COLS)}, record_status, is_active, created_by, updated_by, updated_at) "
                    f"VALUES ({', '.join(':' + c for c in COLS)}, :st, 1, :cb, :cb, :now)"), v)
    pid = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()
    for i, s in enumerate(m.default_specs or []):
        s = (list(s) + [""] * 5)[:5]
        if s[0]:
            db.add(ProductSpec(product_id=pid, parameter=s[0][:200], value=(s[1] or "")[:300], unit=(s[2] or "")[:60] or None, standard=(s[3] or "")[:300] or None,
                               remarks=(s[4] or "")[:500] or None, sort_order=i, updated_by=cu.id))
    stage = body.get("_stage")
    if stage and v["category"]:
        cat = next((c for c in PM.categories(db) if c.name == v["category"]), None)
        st = next((s for s in PM.stages(db) if str(s.id) == str(stage) or s.name == stage), None)
        if not st:
            raise HTTPException(422, f"Choose a configured {m.grouping.lower()} for the primary mapping")
        if cat:
            db.add(ProductCategoryMap(product_id=pid, category_id=cat.id, stage_id=st.id, role="Primary", sort_order=0))
    _history(db, cu, pid, None, "list_price", None, v["list_price"], "Created")
    _history(db, cu, pid, None, "std_cost", None, v["std_cost"], "Created")
    p = {"id": pid, "code": v["sku"], "name": v["name"]}
    PM.log_change(db, cu, p, "Record", "", f"Created as {first}", reason, "", "Not required", force=True)
    _log(db, cu, request, pid, v["name"], "create", f"Product {v['sku']} created",
         new={k: (str(x) if isinstance(x, Decimal) else x) for k, x in v.items() if k not in ("cb", "now")}, icon="🆕")
    db.flush()
    return {"id": pid, "code": v["sku"]}


def _fmt(k: str, v: Any) -> str:
    if v is None or v == "":
        return ""
    if k in ("list", "cost"):
        return f"₹{Decimal(str(v)):,.2f}"
    return str(v)


def update(db: Session, cu: User, request: Optional[Request], pid: int, body: dict[str, Any], partial: bool = False, reason: Optional[str] = None) -> dict[str, Any]:
    cur = get_product(db, pid)
    ctx = PM.edit_context(db, cur)
    merged = {**cur["fields"], "oem": cur["oem_id"]} if partial else {}
    merged.update(body)
    v = validate(db, merged, cur)
    sets = [f"{c}=:{c}" for c in COLS if c != "sku"] + ["updated_by=:ub", "updated_at=:now"]
    db.execute(text(f"UPDATE products_master SET {', '.join(sets)} WHERE id = :id"), {**v, "ub": cu.id, "now": now_ist(), "id": pid})
    new = get_product(db, pid)
    F = {f.field_key: f.label for f in PM.fields(db)}
    oems = {o["id"]: o["name"] for o in oem_list(db)}
    changed = []
    for k, label in F.items():
        if k in ("code", "status"):
            continue
        a, b = cur["fields"].get(k), new["fields"].get(k)
        if k == "oem":
            a, b = oems.get(a, cur["oem"] or ""), oems.get(b, "")
        if (a in (None, "") and b in (None, "")) or str(a) == str(b) or (k in ("list", "cost", "gst") and a is not None and b is not None and float(a) == float(b)):
            continue
        changed.append(k)
        if ctx["log"]:
            PM.log_change(db, cu, cur, "Product Master · " + label, _fmt(k, a), _fmt(k, b), reason or ctx["reason"], ctx["approver"], ctx["approval"])
    _history(db, cu, pid, None, "list_price", Decimal(str(cur["list"])) if cur["list"] is not None else None, v["list_price"])
    _history(db, cu, pid, None, "std_cost", Decimal(str(cur["cost"])) if cur["cost"] is not None else None, v["std_cost"])
    if changed:
        _log(db, cu, request, pid, v["name"], "update", "Updated " + ", ".join(F.get(k, k) for k in changed),
             old={k: cur["fields"].get(k) for k in changed}, new={k: new["fields"].get(k) for k in changed}, icon="✏️")
    return {"changed": len(changed)}


def delete(db: Session, cu: User, request: Optional[Request], pid: int) -> None:
    cur = get_product(db, pid)
    if cur["status"] == PM.lock_status(db):
        raise HTTPException(409, f"{cur['code']} is {cur['status']} – retire it through the lifecycle instead of deleting it")
    if cur.get("pending_status"):
        raise HTTPException(409, f"{cur['code']} is waiting for approval")
    db.execute(text("UPDATE products_master SET is_active = 0, updated_by = :u, updated_at = :n WHERE id = :i"), {"u": cu.id, "n": now_ist(), "i": pid})
    PM.log_change(db, cu, cur, "Record", cur["status"], "Deleted", "Removed from the catalogue", "", "Not required", force=True)
    _log(db, cu, request, pid, cur["name"], "delete", f"Product {cur['code']} deleted", old={"code": cur["code"], "name": cur["name"]}, icon="🗑️")


def used_in_quotes(db: Session, pid: int) -> list[dict[str, Any]]:
    try:
        rows = db.execute(text("SELECT DISTINCT q.id, q.quotation_number, q.revision_number, q.status, COALESCE(c.customer_name, '') AS customer "
                               "FROM quotation_line_items li JOIN quotations q ON q.id = li.quotation_id LEFT JOIN customers c ON c.id = q.customer_id "
                               "WHERE li.product_id = :p ORDER BY q.id DESC LIMIT 20"), {"p": pid}).mappings().all()
    except Exception:
        db.rollback()
        return []
    return [{"id": r["id"], "number": r["quotation_number"], "rev": r["revision_number"], "status": r["status"] or "", "customer": r["customer"]} for r in rows]


# ─── price books ──────────────────────────────────────────────────────────────

def approval_limit(db: Session) -> Optional[Decimal]:
    return Decimal(str(PM.rules(db)["discLimit"]))


def books(db: Session, include_inactive: bool = False) -> list[PriceBook]:
    q = db.query(PriceBook)
    if not include_inactive:
        q = q.filter(PriceBook.is_active == True)
    return q.order_by(PriceBook.sort_order, PriceBook.id).all()


def _bcol(db: Session, b: PriceBook) -> dict[str, Any]:
    r = db.execute(text("SELECT book_type, valid_from, valid_to, applies_to, book_status FROM price_books WHERE id = :i"), {"i": b.id}).mappings().first()
    return dict(r) if r else {"book_type": None, "valid_from": None, "valid_to": None, "applies_to": None, "book_status": "Active"}


def expire_books(db: Session, cu: Optional[User]) -> None:
    """Active books whose validity ended become Expired (logged once)."""
    today = now_ist().date()
    for bid, name, to in db.execute(text("SELECT id, name, valid_to FROM price_books WHERE is_active = 1 AND book_status = 'Active' AND valid_to IS NOT NULL AND valid_to < :t"),
                                    {"t": today}).all():
        db.execute(text("UPDATE price_books SET book_status = 'Expired' WHERE id = :i"), {"i": bid})
        PM.log_change(db, cu, None, f"Price book · {name} · Status", "Active", "Expired", f"Validity ended on {to}", "", "Not required", book_id=bid)


def book_out(db: Session, b: PriceBook) -> dict[str, Any]:
    x = _bcol(db, b)
    n_over = db.query(PriceBookItem).filter(PriceBookItem.price_book_id == b.id, PriceBookItem.price.isnot(None)).count()
    return {"id": b.id, "name": b.name, "currency": b.currency, "rate": float(b.exchange_rate) if b.exchange_rate is not None else None,
            "adjustment": float(b.adjustment or 0), "all_products": bool(b.all_products), "is_default": bool(b.is_default), "approval": b.status,
            "pending_adjustment": float(b.pending_adjustment) if b.pending_adjustment is not None else None, "description": b.description or "",
            "type": x["book_type"] or "Standard", "valid_from": x["valid_from"].isoformat() if x["valid_from"] else None,
            "valid_to": x["valid_to"].isoformat() if x["valid_to"] else None, "applies_to": x["applies_to"] or "", "status": x["book_status"] or "Active",
            "overrides": n_over, "active": bool(b.is_active)}


def get_book(db: Session, bid: int) -> PriceBook:
    b = db.query(PriceBook).filter(PriceBook.id == bid, PriceBook.is_active == True).first()
    if not b:
        raise HTTPException(404, "Price book not found")
    return b


def _to_book(v: Decimal, b: PriceBook, base: str) -> Optional[Decimal]:
    if b.currency == base:
        return v
    if not b.exchange_rate:
        return None
    return v / Decimal(b.exchange_rate)


def book_price(b: PriceBook, base: str, list_price: Optional[float], override: Optional[Decimal]) -> tuple[Optional[Decimal], bool]:
    """(book price in the book currency, converted?) – override wins; foreign books need an exchange rate."""
    if override is not None:
        return Decimal(override), b.currency != base
    if list_price is None:
        return None, False
    p = _to_book(Decimal(str(list_price)) * (Decimal(1) + Decimal(b.adjustment or 0) / 100), b, base)
    return (q2(p) if p is not None else None), b.currency != base


def book_margin(price: Optional[Decimal], cost: Optional[float], b: PriceBook, base: str) -> Optional[int]:
    if price is None or price == 0:
        return None
    c = _to_book(Decimal(str(cost or 0)), b, base)
    if c is None:
        return None
    return int(((Decimal(1) - c / price) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def floor_price(cost: Optional[float], min_margin: float, b: Optional[PriceBook] = None, base: str = "") -> Optional[Decimal]:
    """Lowest book price that keeps the minimum margin over standard cost (prototype: cost × (1 + minMargin %))."""
    if cost is None:
        return None
    f = Decimal(str(cost)) * (Decimal(1) + Decimal(str(min_margin)) / 100)
    if b is not None:
        f = _to_book(f, b, base)
    return q2(f) if f is not None else None


def book_products(db: Session) -> list[dict[str, Any]]:
    st = PM.statuses(db)
    final = st[-1].name if st else None
    r = PM.rules(db)
    return [p for p in products(db) if not (r["quoteApproved"] and p["status"] == final)]


def book_rows(db: Session, b: PriceBook) -> list[dict[str, Any]]:
    base = base_currency(db)
    mm = PM.rules(db)["minMargin"]
    items = {i.product_id: i for i in db.query(PriceBookItem).filter(PriceBookItem.price_book_id == b.id).all()}
    out = []
    for p in book_products(db):
        it = items.get(p["id"])
        if not b.all_products and not it:
            continue
        price, _ = book_price(b, base, p["list"], it.price if it else None)
        fl = floor_price(p["cost"], mm, b, base)
        out.append({"id": p["id"], "code": p["code"], "name": p["name"], "status": p["status"], "list": p["list"], "cost": p["cost"],
                    "price": float(price) if price is not None else None, "margin": book_margin(price, p["cost"], b, base),
                    "override": float(it.price) if it and it.price is not None else None, "pending": float(it.pending_price) if it and it.pending_price is not None else None,
                    "floor": float(fl) if fl is not None else None, "below_floor": bool(price is not None and fl is not None and price < fl)})
    return out


def _needs_approval(db: Session, discount_pct: Decimal) -> bool:
    lim = approval_limit(db)
    return lim is not None and discount_pct < -lim


def _request(db: Session, request: Optional[Request], cu: User, action: str, rid: int):
    from app.services.generic_approval_engine import create_generic_approval_request
    return create_generic_approval_request(db, tenant_id=getattr(getattr(getattr(request, "state", None), "tenant", None), "id", None) if request else None,
                                           requester=cu, module_key="price_book", action_key=action, record_id=rid)


def _date(v: Any, label: str) -> Optional[dt.date]:
    if v in (None, ""):
        return None
    try:
        return dt.date.fromisoformat(str(v)[:10])
    except ValueError:
        raise HTTPException(422, f"{label} must be a date")


def create_book(db: Session, cu: User, request: Optional[Request], body: dict[str, Any]) -> tuple[PriceBook, Optional[str]]:
    """New price book modal: Name · Type · Adjustment on list (%) · Currency · Valid to · Applies to. Starts as Draft."""
    name = str(body.get("name") or "").strip()
    if len(name) < 2:
        raise HTTPException(422, "Name the price book (at least 2 characters)")
    if db.query(PriceBook.id).filter(PriceBook.name == name, PriceBook.is_active == True).first():
        from app.core.validators import field_error
        raise field_error("name", f"A price book named '{name}' already exists.", 409)
    typ = body.get("type") or "Standard"
    if typ not in BOOK_TYPES:
        raise HTTPException(422, f"Type must be one of {', '.join(BOOK_TYPES)}")
    adj = dec(body.get("adjustment"), "Adjustment on list (%)") or D0
    if not Decimal(-100) < adj <= Decimal(1000):
        raise HTTPException(422, "Adjustment on list must be more than −100 % and at most 1000 %")
    cur = str(body.get("currency") or base_currency(db)).strip().upper()
    if cur not in currencies(db):
        raise HTTPException(422, "Choose a currency from the price book currencies")
    today = now_ist().date()
    to = _date(body.get("valid_to"), "Valid to")
    if to is None:
        raise HTTPException(422, "Valid to is required")
    if to < today:
        raise HTTPException(422, "Valid to cannot be in the past")
    applies = _txt(body.get("applies_to"), 300)
    if not applies:
        raise HTTPException(422, "Applies to is required – the customers, segment or scheme this book is for")
    order = (db.query(PriceBook.sort_order).order_by(PriceBook.sort_order.desc()).limit(1).scalar() or 0) + 1
    b = PriceBook(name=name[:120], currency=cur, adjustment=q2(adj), all_products=True, sort_order=order, status="active", created_by=cu.id, is_active=True)
    db.add(b)
    db.flush()
    db.execute(text("UPDATE price_books SET book_type = :t, valid_from = :f, valid_to = :to, applies_to = :a, book_status = 'Draft' WHERE id = :i"),
               {"t": typ, "f": today, "to": to, "a": applies, "i": b.id})
    PM.log_change(db, cu, None, f"Price book · {b.name}", "", f"Created as Draft · {typ} · {float(adj):+g}% · {cur}", "New price book", "", "Not required", book_id=b.id, force=True)
    _log(db, cu, request, None, b.name, "price_book_create", f"Price book {b.name} created", new={"type": typ, "adjustment": str(adj), "currency": cur, "valid_to": str(to)})
    msg = None
    if _needs_approval(db, adj):
        msg = _hold_book(db, cu, request, b, adj, new=True)
    return b, msg


def update_book(db: Session, cu: User, request: Optional[Request], b: PriceBook, body: dict[str, Any]) -> Optional[str]:
    """Price-book details panel: Adjustment on list (%) · Valid from · Valid to · Status · Applies to (+ exchange rate
    for a foreign-currency book). A deeper discount than the limit is held for approval."""
    if b.status == "pending":
        raise HTTPException(409, "This price book is waiting for approval")
    x = _bcol(db, b)
    old = book_out(db, b)
    vf = _date(body["valid_from"], "Valid from") if "valid_from" in body else x["valid_from"]
    vt = _date(body["valid_to"], "Valid to") if "valid_to" in body else x["valid_to"]
    if vf and vt and vt < vf:
        raise HTTPException(422, "Valid to must be on or after Valid from")
    st = body.get("status", x["book_status"] or "Active")
    if st not in BOOK_STATUSES:
        raise HTTPException(422, "Status must be Draft, Active or Expired")
    today = now_ist().date()
    if st == "Active" and vt and vt < today:
        raise HTTPException(422, "The validity has ended – extend Valid to before activating, or mark the book Expired")
    if st == "Active" and b.currency != base_currency(db) and not b.exchange_rate and not body.get("rate"):
        raise HTTPException(422, f"Set the exchange rate ({base_currency(db)} per 1 {b.currency}) before activating this book")
    applies = _txt(body["applies_to"], 300) if "applies_to" in body else x["applies_to"]
    if "applies_to" in body and not applies:
        raise HTTPException(422, "Applies to cannot be empty")
    msg = None
    if "rate" in body:
        r = dec(body.get("rate"), "Exchange rate")
        if b.currency == base_currency(db):
            r = None
        elif r is None or r <= 0:
            raise HTTPException(422, f"Exchange rate must be more than 0 ({base_currency(db)} per 1 {b.currency})")
        if (Decimal(b.exchange_rate) if b.exchange_rate is not None else None) != r:
            PM.log_change(db, cu, None, f"Price book · {b.name} · Exchange rate", b.exchange_rate or "", r or "", "Price book updated", "", "Not required", book_id=b.id)
            b.exchange_rate = r
    if "adjustment" in body:
        adj = dec(body.get("adjustment"), "Adjustment on list (%)")
        if adj is None:
            raise HTTPException(422, "Adjustment on list (%) is required")
        if not Decimal(-100) < adj <= Decimal(1000):
            raise HTTPException(422, "Adjustment on list must be more than −100 % and at most 1000 %")
        adj = q2(adj)
        if Decimal(b.adjustment or 0) != adj:
            if _needs_approval(db, adj):
                msg = _hold_book(db, cu, request, b, adj, new=False)
            else:
                _history(db, cu, None, b.id, "adjustment", Decimal(b.adjustment or 0), adj, b.name)
                PM.log_change(db, cu, None, f"Price book · {b.name} · Adjustment on list (%)", f"{float(b.adjustment or 0):+g}%", f"{float(adj):+g}%",
                              "Price book updated", "", "Not required", book_id=b.id)
                b.adjustment = adj
    for k, ov, nv, lbl in (("valid_from", x["valid_from"], vf, "Valid from"), ("valid_to", x["valid_to"], vt, "Valid to"), ("book_status", x["book_status"], st, "Status"),
                           ("applies_to", x["applies_to"], applies, "Applies to")):
        if (ov or None) != (nv or None):
            PM.log_change(db, cu, None, f"Price book · {b.name} · {lbl}", ov or "", nv or "", "Price book updated", "", "Not required", book_id=b.id)
    db.execute(text("UPDATE price_books SET valid_from = :f, valid_to = :t, book_status = :s, applies_to = :a WHERE id = :i"),
               {"f": vf, "t": vt, "s": st, "a": applies, "i": b.id})
    _log(db, cu, request, None, b.name, "price_book_update", f"Price book {b.name} updated", old=old, new={k: str(v) for k, v in body.items()})
    return msg


def _hold_book(db: Session, cu: User, request: Optional[Request], b: PriceBook, adj: Decimal, new: bool) -> str:
    req = _request(db, request, cu, "discount", b.id)
    if (req.status or "").strip().lower() == "approved":
        _history(db, cu, None, b.id, "adjustment", Decimal(b.adjustment or 0), adj, f"{b.name} (approved)")
        PM.log_change(db, cu, None, f"Price book · {b.name} · Adjustment on list (%)", f"{float(b.adjustment or 0):+g}%", f"{float(adj):+g}%",
                      "Discount beyond the approval limit", "Auto-approved" if (req.approval_mode or "") == "auto" else cu.full_name, "Approved", book_id=b.id, request_id=req.id)
        b.adjustment, b.status = adj, "active"
        return f"Discount of {abs(float(adj)):g}% approved and applied"
    b.pending_adjustment, b.approval_request_id = adj, req.id
    PM.log_change(db, cu, None, f"Price book · {b.name} · Adjustment on list (%)", f"{float(b.adjustment or 0):+g}%", f"{float(adj):+g}%",
                  "Discount beyond the approval limit", "", "Pending", book_id=b.id, request_id=req.id)
    if new:
        b.adjustment = D0
        b.status = "pending"
    return f"A discount of {abs(float(adj)):g}% is beyond the {float(approval_limit(db)):g}% limit – sent for Sales Head approval"


def set_override(db: Session, cu: User, request: Optional[Request], b: PriceBook, pid: int, price: Optional[Any]) -> Optional[str]:
    """Product-specific book price. Below the floor: Warn (saved, flagged) · Block (refused) · Approval (held).
    Deeper than the discount limit below list: held for approval."""
    p = get_product(db, pid)
    if p["id"] not in {x["id"] for x in book_products(db)}:
        raise HTTPException(422, f"{p['code']} is not offered in price books")
    it = db.query(PriceBookItem).filter(PriceBookItem.price_book_id == b.id, PriceBookItem.product_id == pid).first()
    if it and it.pending_price is not None:
        raise HTTPException(409, "An override for this product is waiting for approval")
    new = dec(price, "Override")
    if new is not None and new < 0:
        raise HTTPException(422, "Override must be zero or more")
    if it is None:
        it = PriceBookItem(price_book_id=b.id, product_id=pid, updated_by=cu.id)
        db.add(it)
        db.flush()
    old = Decimal(it.price) if it.price is not None else None
    field = f"Price book · {b.name} · Override"
    if new is None:
        if old is None:
            return None
        it.price = None
        _history(db, cu, pid, b.id, "override", old, None, f"{b.name}: override removed")
        PM.log_change(db, cu, p, field, old, "Removed (book rule applies)", "Override removed", "", "Not required", book_id=b.id)
        _log(db, cu, request, pid, p["name"], "price_override", f"{b.name}: override removed", old={"price": float(old)})
        return None
    new = q2(new)
    base = base_currency(db)
    r = PM.rules(db)
    fl = floor_price(p["cost"], r["minMargin"], b, base)
    below = fl is not None and new < fl
    warn = None
    hold_reason = None
    if below:
        if r["floorPolicy"] == "Block":
            raise HTTPException(422, f"{new} is below the floor {fl} (standard cost + {r['minMargin']:g}% minimum margin) – company policy blocks it")
        if r["floorPolicy"] == "Approval":
            hold_reason = f"below the floor {fl} (cost + {r['minMargin']:g}%)"
        else:
            warn = f"Saved – {new} is below the floor {fl} (cost + {r['minMargin']:g}% minimum margin) and is flagged"
    list_in_book = _to_book(Decimal(str(p["list"])), b, base) if p["list"] else None
    if list_in_book and _needs_approval(db, (new / list_in_book - 1) * 100):
        hold_reason = hold_reason or f"more than {float(approval_limit(db)):g}% below list"
    if hold_reason:
        req = _request(db, request, cu, "override", it.id)
        if (req.status or "").strip().lower() != "approved":
            it.pending_price, it.approval_request_id = new, req.id
            PM.log_change(db, cu, p, field, old if old is not None else "", new, f"Override {hold_reason}", "", "Pending", book_id=b.id, request_id=req.id)
            _log(db, cu, request, pid, p["name"], "price_override", f"{b.name}: override {new} sent for approval", new={"pending_price": float(new)})
            return f"Override is {hold_reason} – sent for Sales Head approval"
        PM.log_change(db, cu, p, field, old if old is not None else "", new, f"Override {hold_reason}",
                      "Auto-approved" if (req.approval_mode or "") == "auto" else cu.full_name, "Approved", book_id=b.id, request_id=req.id)
    else:
        PM.log_change(db, cu, p, field, old if old is not None else "", new, "Override set" + (" (below floor)" if below else ""), "", "Not required", book_id=b.id)
    it.price, it.updated_by = new, cu.id
    _history(db, cu, pid, b.id, "override", old, new, b.name)
    _log(db, cu, request, pid, p["name"], "price_override", f"{b.name}: book price set to {new}", old={"price": float(old) if old is not None else None},
         new={"price": float(new)})
    return warn


def on_decision(db: Session, request_row, actor: User, remarks: str = "") -> None:
    """Approval engine callback (module "price_book")."""
    status = (request_row.status or "").strip().lower()
    if request_row.action_key == "discount":
        b = db.query(PriceBook).filter(PriceBook.approval_request_id == request_row.id).first()
        if not b or b.pending_adjustment is None:
            return
        f = f"Price book · {b.name} · Adjustment on list (%)"
        if status == "approved":
            db.add(ProductPriceHistory(price_book_id=b.id, field="adjustment", old_value=b.adjustment, new_value=b.pending_adjustment,
                                       note=f"{b.name} (approved)", changed_by=actor.id))
            PM.log_change(db, actor, None, f, f"{float(b.adjustment or 0):+g}%", f"{float(b.pending_adjustment):+g}%", remarks or "Approved", actor.full_name, "Approved",
                          book_id=b.id, request_id=request_row.id)
            b.adjustment, b.status = b.pending_adjustment, "active"
            b.pending_adjustment = b.approval_request_id = None
        elif status == "rejected":
            PM.log_change(db, actor, None, f, f"{float(b.adjustment or 0):+g}%", f"{float(b.pending_adjustment):+g}% (rejected)", remarks or "Rejected", actor.full_name,
                          "Rejected", book_id=b.id, request_id=request_row.id)
            b.status = "rejected" if b.status == "pending" else "active"
            b.pending_adjustment = b.approval_request_id = None
    elif request_row.action_key == "override":
        it = db.query(PriceBookItem).filter(PriceBookItem.approval_request_id == request_row.id).first()
        if not it or it.pending_price is None:
            return
        b = db.query(PriceBook).filter(PriceBook.id == it.price_book_id).first()
        try:
            p = get_product(db, it.product_id)
        except HTTPException:
            p = {"id": it.product_id, "code": "", "name": ""}
        f = f"Price book · {b.name if b else ''} · Override"
        if status == "approved":
            db.add(ProductPriceHistory(product_id=it.product_id, price_book_id=it.price_book_id, field="override", old_value=it.price,
                                       new_value=it.pending_price, note="approved", changed_by=actor.id))
            PM.log_change(db, actor, p, f, it.price if it.price is not None else "", it.pending_price, remarks or "Approved", actor.full_name, "Approved",
                          book_id=it.price_book_id, request_id=request_row.id)
            it.price = it.pending_price
            it.pending_price = it.approval_request_id = None
        elif status == "rejected":
            PM.log_change(db, actor, p, f, it.price if it.price is not None else "", f"{it.pending_price} (rejected)", remarks or "Rejected", actor.full_name, "Rejected",
                          book_id=it.price_book_id, request_id=request_row.id)
            it.pending_price = it.approval_request_id = None


def delete_book(db: Session, cu: User, request: Optional[Request], b: PriceBook) -> None:
    if b.is_default:
        raise HTTPException(409, "The default price book cannot be deleted")
    b.is_active = False
    PM.log_change(db, cu, None, f"Price book · {b.name}", "", "Deleted", "Price book deleted", "", "Not required", book_id=b.id, force=True)
    _log(db, cu, request, None, b.name, "price_book_delete", f"Price book {b.name} deleted", old=book_out(db, b))


def quote_books(db: Session) -> list[dict[str, Any]]:
    """Price books a quote line can use: Active, valid today, not waiting for approval and convertible to the base
    currency (quotes are priced in the base currency)."""
    today = now_ist().date()
    base = base_currency(db)
    out = []
    for b in books(db):
        x = book_out(db, b)
        if x["status"] != "Active" or b.status == "pending":
            continue
        if (x["valid_from"] and x["valid_from"] > today.isoformat()) or (x["valid_to"] and x["valid_to"] < today.isoformat()):
            continue
        if b.currency != base and not b.exchange_rate:
            continue
        out.append(x)
    return out


def effective_price(db: Session, b: Optional[PriceBook], p: dict) -> dict[str, Any]:
    """Quote price of a product in the base currency: the book price (override wins), else list price."""
    base = base_currency(db)
    r = PM.rules(db)
    fl = floor_price(p["cost"], r["minMargin"])
    if b is None or p["list"] is None:
        price = Decimal(str(p["list"])) if p["list"] is not None else None
        over = False
    else:
        it = db.query(PriceBookItem).filter(PriceBookItem.price_book_id == b.id, PriceBookItem.product_id == p["id"]).first()
        bp, _ = book_price(b, base, p["list"], it.price if it else None)
        over = bool(it and it.price is not None)
        price = (bp * Decimal(b.exchange_rate) if (bp is not None and b.currency != base) else bp)
    price = q2(price) if price is not None else None
    return {"price": float(price) if price is not None else None, "override": over, "floor": float(fl) if fl is not None else None,
            "margin": margin(price, p["cost"]) if price else None}


# ─── v17 drawer data (kept for history) ───────────────────────────────────────

def names(db: Session, ids) -> dict[int, str]:
    ids = {int(i) for i in ids if i}
    return {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(ids)).all()} if ids else {}


def notes(db: Session, pid: int) -> list[dict[str, Any]]:
    rows = db.query(ProductNote).filter(ProductNote.product_id == pid).order_by(ProductNote.id.desc()).all()
    who = names(db, [n.created_by for n in rows])
    return [{"id": n.id, "body": n.body, "by": who.get(n.created_by, ""), "at": n.created_at.isoformat() if n.created_at else None} for n in rows]
