"""Product & Price Books (prototype v18 · Sales → Product & Price Books)   /api/v1/products

Catalogue (KPIs, status chips, saved views, grid) · product record (Overview / Specifications / Category mapping /
Pricing / Lifecycle / Change log / Brochure) · Category map · Price books · Change log · Configuration (company
product model) · Product Master Excel workbook (download / import with preview).

The company is the tenant: every query runs on the tenant database resolved from the user's session, so a company
only ever sees its own model, products, price books and history.

Permissions: products.view / create / update / delete / export; Configuration needs settings.manage.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import json
from statistics import mean
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.core.validators import detail_text
from app.core.logging import log_audit_db
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.services import product_model_service as PM
from app.services import product_service as S

router = APIRouter()

VIEWS = ["All", "Low margin < 25%", "Backorder / low stock", "Services"]
# prototype v18 catalogue: Product code | [Company] | Product description | Category | Used in | Record status | COO | Unit | List price | Std cost | Margin | Updated
COLUMNS = ["code", "name", "cat", "used", "status", "coo", "unit", "list", "cost", "margin", "updated_at"]
NUMERIC = {"list", "cost", "margin", "used"}


def product_user(request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "products.view"):
        raise HTTPException(403, "You do not have access to Product & Price Books")
    S.ensure_schema(db)
    return cu


def _need(db: Session, cu: User, key: str, what: str) -> None:
    if not user_has_permission(db, cu, key):
        raise HTTPException(403, f"You do not have permission to {what}")


def _can(db: Session, cu: User) -> dict[str, bool]:
    return {k: user_has_permission(db, cu, f"products.{k}") for k in ("create", "update", "delete", "export")} | {
        "configure": user_has_permission(db, cu, "settings.manage")}


def _company(db: Session, request: Request) -> dict[str, str]:
    from app.services.quote_service import tenant_info
    t = getattr(request.state, "tenant", None)
    return {"id": str(getattr(t, "slug", "") or db.info.get("tenant_slug") or "company"), "name": tenant_info(db)["name"] or "Company"}


def _model_summary(db: Session) -> dict[str, Any]:
    m = PM.model_out(db)
    return {"name": m["name"], "grouping": m["grouping"], "categories": sum(1 for c in m["categories"] if not c["internal"]), "stages": len(m["stages"]),
            "statuses": len(m["statuses"]), "fields": sum(1 for f in m["fields"] if f["on"])}


@router.get("/meta")
def meta(request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    co = _company(db, request)
    return {"company": co["name"], "companies": [{**co, "summary": _model_summary(db)}], "views": VIEWS, "model": PM.model_out(db),
            "config": S.config(db), "lookups": S.lookups(db), "can": _can(db, cu), "me": {"id": cu.id, "name": cu.full_name}}


# ─── catalogue ────────────────────────────────────────────────────────────────

def _in_view(r: dict, view: str) -> bool:
    if view.startswith("Low margin"):
        return r["margin"] < 25
    if view.startswith("Backorder"):
        return r["stock"] != "In stock"
    if view == "Services":
        return (r["cat"] or "").strip().lower() == "services"
    return True


def _txt(r: dict, k: str) -> str:
    v = r.get(k)
    return "" if v is None else str(v)


def _cond(r: dict, k: str, op: str, v: str) -> bool:
    t, tl, vl = _txt(r, k), _txt(r, k).lower(), (v or "").lower()
    try:
        n, vn = float(r.get(k) or 0), float(v)
    except (TypeError, ValueError):
        n = vn = None
    return {"contains": vl in tl, "ncontains": vl not in tl, "eq": tl == vl or (n is not None and n == vn), "ne": not (tl == vl or (n is not None and n == vn)),
            "starts": tl.startswith(vl), "gt": n is not None and n > vn, "lt": n is not None and n < vn, "gte": n is not None and n >= vn,
            "lte": n is not None and n <= vn, "empty": t.strip() in ("", "—"), "nempty": t.strip() not in ("", "—")}.get(op, True)


def _catalogue(db: Session) -> list[dict[str, Any]]:
    rows = S.products(db)
    used: dict[int, set] = {}
    prim: dict[int, int] = {}
    for x in PM.mappings(db):
        used.setdefault(x["product_id"], set()).add(x["category_id"])
        prim[x["product_id"]] = prim.get(x["product_id"], 0) + (x["role"] == "Primary")
    for r in rows:
        r["used"] = len(used.get(r["id"], set()))
        r["primary"] = prim.get(r["id"], 0)
        r["used_ids"] = sorted(used.get(r["id"], set()))
    return rows


@router.get("/list")
def list_products(view: str = "All", status: str = "", category: str = "", q: str = "", f: str = "", adv: str = "", sorts: str = "",
                  offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=1000), db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    try:
        quick, advf, order = (json.loads(f) if f else {}), (json.loads(adv) if adv else {}), (json.loads(sorts) if sorts else [])
    except ValueError:
        raise HTTPException(422, "Invalid filter or sort")
    rows = _catalogue(db)
    m = PM.model_out(db)
    st = [s["name"] for s in m["statuses"]]
    # KPI strip (prototype pxCatalogue): Products · <approved status> · In review · Draft · Categories in use · Avg margin
    lock_n = sum(1 for r in rows if r["status"] == m["lock"])
    margins = [(1 - (r["cost"] or 0) / r["list"]) * 100 for r in rows if r["list"]]
    kpi = {"products": len(rows), "lock_label": m["lock"], "approved": lock_n, "approved_pct": round(lock_n * 100 / len(rows)) if rows else 0,
           "review": sum(1 for r in rows if m["review"] and r["status"] == m["review"]), "review_label": m["review"],
           "draft": sum(1 for r in rows if r["status"] == m["draft"]), "draft_label": m["draft"],
           "categories": len({c for r in rows for c in r["used_ids"]}), "avg_margin": round(mean(margins)) if margins else 0}
    status_counts = [{"name": s, "count": sum(1 for r in rows if r["status"] == s)} for s in st]
    other = sum(1 for r in rows if r["status"] not in st)
    if other:
        status_counts.append({"name": "(not set)", "count": other})
    counts = {v: sum(1 for r in rows if _in_view(r, v)) for v in VIEWS}
    sel = [r for r in rows if _in_view(r, view)]
    if status and status != "All":
        sel = [r for r in sel if (r["status"] or "(not set)") == status or (status == "(not set)" and r["status"] not in st)]
    if category:
        sel = [r for r in sel if (r["cat"] or "") == category]
    if q.strip():
        ql = q.strip().lower()
        sel = [r for r in sel if any(ql in _txt(r, k).lower() for k in COLUMNS + ["longDesc", "oem"])]
    for k, v in (quick or {}).items():
        if k in COLUMNS and str(v or "").strip():
            sel = [r for r in sel if str(v).lower() in _txt(r, k).lower()]
    conds = [c for c in (advf.get("conds") or []) if isinstance(c, dict) and c.get("k") in COLUMNS]
    if conds:
        test = all if advf.get("logic") != "OR" else any
        sel = [r for r in sel if test(_cond(r, c["k"], str(c.get("op") or "contains"), str(c.get("v") or "")) for c in conds)]
    items = [x for x in order if isinstance(x, (list, tuple)) and len(x) == 2 and x[0] in COLUMNS]
    for k, d in reversed(items):
        sel.sort(key=lambda r: (r[k] if r[k] is not None else -1e18) if k in NUMERIC else _txt(r, k).lower(), reverse=int(d) < 0)
    for r in rows:
        r.pop("used_ids", None)
        r.pop("fields", None)
    return {"items": sel[offset:offset + limit], "total": len(sel), "total_all": len(rows), "counts": counts, "status_counts": status_counts, "kpi": kpi,
            "min_margin": m["rules"]["minMargin"]}


@router.get("/export")
def export_csv(view: str = "All", status: str = "", db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.export", "export products")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Product code", "Product description", "Category", "Used in", "Record status", "COO", "Unit", "List price", "Std cost", "Margin", "Updated"])
    for r in _catalogue(db):
        if _in_view(r, view) and (not status or status == "All" or r["status"] == status):
            w.writerow([r["code"], r["name"], r["cat"], r["used"], r["status"], r["coo"], r["unit"], r["list"] if r["list"] is not None else "",
                        r["cost"] if r["cost"] is not None else "", f"{r['margin']}%", (r["updated_at"] or "")[:10]])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="products.csv"'})


class ProductIn(BaseModel):
    """Values keyed by product-model field key (code, name, cat, longDesc, features, coo, policy, guide, supply, unit,
    list, cost, oem, stock, gst and model / custom field keys); _stage = primary mapping row for a new product."""
    values: dict[str, Any] = Field(default_factory=dict)
    stage: Optional[int] = None
    reason: Optional[str] = Field(None, max_length=500)

    @field_validator("values")
    @classmethod
    def _vals(cls, v):
        if len(v) > 200:
            raise ValueError("Too many fields")
        for k, x in v.items():
            if not isinstance(k, str) or len(k) > 60:
                raise ValueError("Invalid field")
            if x is not None and not isinstance(x, (str, int, float, bool)):
                raise ValueError(f"Invalid value for {k}")
        return v


@router.post("", status_code=201)
def create(body: ProductIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.create", "create products")
    vals = {k: v for k, v in body.values.items() if k != "status"}
    if body.stage:
        vals["_stage"] = body.stage
    res = S.create(db, cu, request, vals)
    db.commit()
    return res


# ─── category map, change log, configuration, workbook ────────────────────────

@router.get("/matrix")
def matrix(internal: bool = False, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    return PM.matrix(db, internal)


@router.get("/changelog")
def changelog(product_id: Optional[int] = None, user_id: Optional[int] = None, date_from: Optional[str] = None, date_to: Optional[str] = None, q: str = "",
              db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    for d in (date_from, date_to):
        if d:
            try:
                dt.date.fromisoformat(d)
            except ValueError:
                raise HTTPException(422, "Dates must be YYYY-MM-DD")
    rows = PM.change_log(db, product_id, user_id, date_from, date_to, q)
    users = sorted({(r["by_id"], r["by"]) for r in rows if r["by_id"]}, key=lambda x: x[1])
    prods = sorted({(r["product_id"], r["code"], r["name"]) for r in rows if r["product_id"]}, key=lambda x: x[1])
    return {"items": rows, "users": [{"id": i, "name": n} for i, n in users], "products": [{"id": i, "code": c, "name": n} for i, c, n in prods]}


@router.get("/model")
def get_model(db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    return PM.model_out(db)


class ModelIn(BaseModel):
    name: Optional[str] = Field(None, max_length=120)
    grouping: Optional[str] = Field(None, max_length=60)
    roles: Optional[list[str]] = None
    life: Optional[list[str]] = None
    units: Optional[list[str]] = None
    code: Optional[str] = Field(None, max_length=40)
    specs: Optional[list[list[str]]] = None
    rules: Optional[dict[str, Any]] = None
    categories: Optional[list[dict[str, Any]]] = None
    stages: Optional[list[dict[str, Any]]] = None
    statuses: Optional[list[dict[str, Any]]] = None
    fields: Optional[list[dict[str, Any]]] = None
    currencies: Optional[list[str]] = None


@router.put("/model")
def put_model(body: ModelIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "settings.manage", "change the product model")
    before = PM.model_out(db)
    data = body.model_dump(exclude_unset=True)
    cur = data.pop("currencies", None)
    after = PM.save_model(db, cu, data)
    if cur is not None:
        S.save_currencies(db, cu, cur)
    log_audit_db(db, cu.id, "settings", "product_model", None, get_request_ip(request), "Product model updated: " + ", ".join(body.model_dump(exclude_unset=True)),
                 old_data={k: before.get(k) for k in data}, new_data={k: after.get(k) for k in data}, record_name="Product & Price Books → Configuration")
    db.commit()
    return {**PM.model_out(db), "config": S.config(db)}


class TemplateIn(BaseModel):
    template: Literal["mfg", "b2b", "epc", "waste"]


@router.post("/model/template")
def apply_template(body: TemplateIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "settings.manage", "change the product model")
    before = PM.model_out(db)["template"]
    out = PM.apply_template(db, cu, request, body.template)
    log_audit_db(db, cu.id, "settings", "product_model", None, get_request_ip(request), f"Product model set to {out['name']}", old_data={"template": before},
                 new_data={"template": body.template}, record_name="Product & Price Books → Configuration")
    db.commit()
    return out


class CustomFieldIn(BaseModel):
    label: str = Field(..., min_length=1, max_length=150)
    type: Literal["text", "num", "date", "ta"] = "text"
    required: bool = False


@router.post("/model/fields", status_code=201)
def add_field(body: CustomFieldIn, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "settings.manage", "change the product model")
    out = PM.add_custom_field(db, cu, body.label, body.type, body.required)
    db.commit()
    return out


@router.get("/template")
def download_template(request: Request, products: bool = True, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    if products:
        _need(db, cu, "products.export", "export products")
    co = _company(db, request)
    data = PM.workbook(db, co["name"], include_products=products)
    fn = f"Product_Master_{''.join(ch for ch in co['name'] if ch.isalnum())[:30] or 'Company'}.xlsx"
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f'attachment; filename="{fn}"'})


MAX_IMPORT = 10 * 1024 * 1024


@router.post("/import")
async def import_products(request: Request, file: UploadFile = File(...), dry_run: bool = Query(True), db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    """Product Master workbook. dry_run=true returns the row-level preview; dry_run=false imports – refused while any
    row has errors (rows are never skipped silently)."""
    _need(db, cu, "products.create", "import products")
    raw = await file.read()
    if len(raw) > MAX_IMPORT:
        raise HTTPException(413, "The workbook is larger than 10 MB")
    prev = PM.parse_import(db, raw, file.filename or "")
    if dry_run:
        return {**prev, "dry_run": True}
    if prev["products"] and not user_has_permission(db, cu, "products.update") and any(x["action"] == "update" for x in prev["products"]):
        raise HTTPException(403, "Updating existing products needs permission to edit products")
    res = PM.commit_import(db, cu, request, prev)
    log_audit_db(db, cu.id, "products", "import", None, get_request_ip(request), f"Product Master import: {res['added']} added, {res['updated']} updated",
                 new_data={"file": file.filename, **res}, record_name=file.filename)
    db.commit()
    return {**prev, **res, "dry_run": False}


# ─── price books ──────────────────────────────────────────────────────────────

@router.get("/books/all")
def list_books(db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    S.expire_books(db, cu)
    db.commit()
    return {"items": [S.book_out(db, b) for b in S.books(db)], "config": S.config(db)}


@router.get("/books/{bid}")
def book_detail(bid: int, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    b = S.get_book(db, bid)
    return {**S.book_out(db, b), "rows": S.book_rows(db, b), "approval_limit": S.config(db)["approval_limit"], "min_margin": S.config(db)["min_margin"],
            "floor_policy": S.config(db)["floor_policy"], "base_currency": S.base_currency(db)}


class BookIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    type: str = "Standard"
    adjustment: Optional[float] = 0
    currency: Optional[str] = None
    valid_to: Optional[str] = None
    applies_to: Optional[str] = Field(None, max_length=300)


@router.post("/books", status_code=201)
def create_book(body: BookIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.create", "create price books")
    b, msg = S.create_book(db, cu, request, body.model_dump())
    db.commit()
    return {**S.book_out(db, b), "message": msg}


class BookPatch(BaseModel):
    adjustment: Optional[float] = None
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    status: Optional[Literal["Draft", "Active", "Expired"]] = None
    applies_to: Optional[str] = Field(None, max_length=300)
    rate: Optional[float] = None


@router.patch("/books/{bid}")
def update_book(bid: int, body: BookPatch, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.update", "edit price books")
    msg = S.update_book(db, cu, request, S.get_book(db, bid), body.model_dump(exclude_unset=True))
    db.commit()
    return {**S.book_out(db, S.get_book(db, bid)), "message": msg}


@router.delete("/books/{bid}")
def delete_book(bid: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.delete", "delete price books")
    S.delete_book(db, cu, request, S.get_book(db, bid))
    db.commit()
    return {"ok": True}


class OverrideIn(BaseModel):
    price: Optional[float] = None


@router.put("/books/{bid}/products/{pid}")
def set_override(bid: int, pid: int, body: OverrideIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    """Product-specific book price (empty = back to the book rule)."""
    _need(db, cu, "products.update", "change book prices")
    b = S.get_book(db, bid)
    if b.status == "pending":
        raise HTTPException(409, "This price book is waiting for approval")
    msg = S.set_override(db, cu, request, b, pid, body.price)
    db.commit()
    row = next((r for r in S.book_rows(db, b) if r["id"] == pid), None)
    return {"ok": True, "message": msg, "row": row}


# ─── bulk ─────────────────────────────────────────────────────────────────────

class BulkIn(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=1000)
    action: Literal["delete"]


@router.post("/bulk")
def bulk(body: BulkIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.delete", "delete products")
    done, failed = 0, []
    for pid in dict.fromkeys(body.ids):
        try:
            S.delete(db, cu, request, pid)
            db.commit()
            done += 1
        except HTTPException as exc:
            db.rollback()
            failed.append({"id": pid, "error": detail_text(exc.detail, "Not allowed")})
    return {"done": done, "failed": failed}


# ─── product record ───────────────────────────────────────────────────────────

def _detail(db: Session, cu: User, request: Request, pid: int) -> dict[str, Any]:
    p = S.get_product(db, pid)
    base = S.base_currency(db)
    r = PM.rules(db)
    pricing = []
    offered = p["id"] in {x["id"] for x in S.book_products(db)}
    for b in (S.books(db) if offered else []):
        it = db.query(S.PriceBookItem).filter(S.PriceBookItem.price_book_id == b.id, S.PriceBookItem.product_id == pid).first()
        price, _ = S.book_price(b, base, p["list"], it.price if it else None)
        bo = S.book_out(db, b)
        pricing.append({"id": b.id, "name": b.name, "applies_to": bo["applies_to"], "adjustment": bo["adjustment"], "currency": b.currency, "status": bo["status"],
                        "price": float(price) if price is not None else None, "override": bool(it and it.price is not None),
                        "margin": S.book_margin(price, p["cost"], b, base)})
    who = S.names(db, [p["created_by"], p["updated_by"]])
    log = PM.change_log(db, product_id=pid, limit=500)
    lock = PM.lock_status(db)
    w = PM.open_window(db, pid)
    fl = S.floor_price(p["cost"], r["minMargin"])
    return {**p, "company": _company(db, request)["name"], "specs": PM.specs(db, pid), "mappings": PM.mappings(db, pid), "pricing": pricing,
            "quotes": S.used_in_quotes(db, pid), "log": log, "actions": PM.actions(db, p), "locked": p["status"] == lock, "lock_status": lock,
            "window": PM.window_out(w), "missing": PM.missing_for_review(db, p), "floor": float(fl) if fl is not None else None,
            "created_by_name": who.get(p["created_by"], ""), "updated_by_name": who.get(p["updated_by"], ""), "can": _can(db, cu)}


@router.get("/{pid}")
def detail(pid: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    return _detail(db, cu, request, pid)


@router.put("/{pid}")
def update(pid: int, body: ProductIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.update", "edit products")
    res = S.update(db, cu, request, pid, {k: v for k, v in body.values.items() if k not in ("status", "code")}, partial=True)
    db.commit()
    return {"id": pid, **res}


@router.delete("/{pid}")
def delete(pid: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.delete", "delete products")
    S.delete(db, cu, request, pid)
    db.commit()
    return {"ok": True}


class SpecRow(BaseModel):
    id: Optional[int] = None
    p: str = Field("", max_length=200)
    v: str = Field("", max_length=300)
    u: str = Field("", max_length=60)
    std: str = Field("", max_length=300)
    rm: str = Field("", max_length=500)


class SpecsIn(BaseModel):
    rows: list[SpecRow] = Field(default_factory=list, max_length=200)


@router.put("/{pid}/specs")
def put_specs(pid: int, body: SpecsIn, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.update", "edit products")
    p = S.get_product(db, pid)
    ctx = PM.edit_context(db, p)
    out = PM.save_specs(db, cu, p, [r.model_dump() for r in body.rows], ctx)
    db.commit()
    return {"specs": out}


class MapRow(BaseModel):
    id: Optional[int] = None
    category_id: Optional[int] = None
    stage_id: Optional[int] = None
    role: str = Field("Primary", max_length=40)
    rm: str = Field("", max_length=500)


class MapsIn(BaseModel):
    rows: list[MapRow] = Field(default_factory=list, max_length=100)


@router.put("/{pid}/mappings")
def put_mappings(pid: int, body: MapsIn, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.update", "edit products")
    p = S.get_product(db, pid)
    ctx = PM.edit_context(db, p)
    out = PM.save_mappings(db, cu, p, [r.model_dump() for r in body.rows], ctx)
    db.commit()
    return {"mappings": out}


class StatusIn(BaseModel):
    to: str = Field(..., min_length=1, max_length=60)
    reason: str = Field("", max_length=500)


@router.post("/{pid}/status")
def move_status(pid: int, body: StatusIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.update", "change the record status")
    p = S.get_product(db, pid)
    res = PM.move_status(db, cu, request, p, body.to, body.reason)
    S._log(db, cu, request, pid, p["name"], "status_change", f"Record status: {p['status']} → {body.to}" + (" (sent for approval)" if res["pending"] else ""),
           old={"status": p["status"]}, new={"status": res["status"], "pending": res["pending"]}, icon="🔁")
    db.commit()
    return res


class WindowIn(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500)


@router.post("/{pid}/change-window")
def change_window(pid: int, body: WindowIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.update", "edit products")
    res = PM.request_window(db, cu, request, S.get_product(db, pid), body.reason)
    db.commit()
    return res


@router.post("/{pid}/change-window/close")
def close_change_window(pid: int, db: Session = Depends(get_tenant_db), cu: User = Depends(product_user)):
    _need(db, cu, "products.update", "edit products")
    PM.close_window(db, cu, S.get_product(db, pid))
    db.commit()
    return {"ok": True}
