"""Cost & margin (Business → Cost & Margin).

Costs (INR / month) – nothing is estimated; a category with no source shows zero and says why.
  Server pools   ``monthly_cost`` of every live PLATFORM_SERVERS entry (platform_infrastructure). A server's cost goes to
                 the categories in its optional ``cost_split`` ({"compute": 60, "database": 30, "storage": 10, …}, any of
                 compute / database / storage / ai / egress, read as shares); without one, a server hosting only
                 databases is Database, a server without databases is Compute, and a server running the API and databases
                 (``local`` or ``agent_url`` plus ``db_host``) is split half Compute, half Database.
  Unit rates     Control Center → Cost & capacity: storage ₹/GB-month, AI ₹/question, egress ₹/GB – for consumption
                 billed outside the servers (object storage, an AI API, bandwidth). Added on top of the pools.
  Support        Control Center "Monthly support cost" (the platform team's cost of serving tenants).
Allocation of shared pools to tenants, by this month's measurements (all tenants, so a scoped view never inflates shares):
  Compute        API requests (usage meter ``api``)
  Database       size of the tenant's database (information_schema, data + index)
  Storage        document storage in use (Tenant.used_storage, as Usage monitoring)
  AI             AI Smart Search questions (usage meter ``ai``)
  Egress         response bytes (usage meter ``egress_kb``, from Content-Length; streamed downloads are not counted)
  Support        support tickets opened this month
  When nothing was measured for a pool this month it is split evenly across active and trial tenants.
Revenue (GST is never included – prices are pre-tax):
  Original MRR   monthly subscription price while paying (Billing & Metering rule) plus active add-ons
  Discount       Discounts & coupons engine (volume, negotiated, coupons, annual prepay) on the tenant's current billing
                 period, with its eligibility, stacking and cap rules, spread evenly over the period's months; then the
                 partner (reseller) commission on what remains – so no amount is deducted twice
  Net MRR = Original − Discount;  Gross profit = Net MRR − Total cost;  Gross margin = profit / Net MRR (None when no revenue)
History: each month's figures are written to platform_cost_months (current month refreshed while it runs, earlier months
kept as last written); the 6-month trend reads only those rows.
"""

from __future__ import annotations

import io
import logging
import threading
import time
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from sqlalchemy import Column, Date, DateTime, Integer, Numeric, String, UniqueConstraint, func, or_, text
from sqlalchemy.orm import Session

from app.database import Base, MasterSessionLocal, master_engine
from app.models.platform_monitoring import PlatformTenantUsageHour
from app.models.tenant import Tenant
from app.services import platform_billing as billing
from app.services import platform_controls as controls

logger = logging.getLogger(__name__)

ZERO = Decimal("0")
CENT = Decimal("0.01")
CATS = ("compute", "database", "storage", "ai", "egress", "support")
POOL_CATS = ("compute", "database", "storage", "ai", "egress")
CAT_LABELS = {"compute": "Compute", "database": "Database", "storage": "Storage", "ai": "AI", "egress": "Egress", "support": "Support"}
DISCOUNT_KINDS = ("coupon", "volume", "negotiated", "partner", "annual")
DISCOUNT_LABELS = {"coupon": "Coupons", "volume": "Volume", "negotiated": "Negotiated", "partner": "Partner", "annual": "Annual prepay"}
RATE_KEYS = {"storage": "costRateStorage", "ai": "costRateAi", "egress": "costRateEgress"}
CACHE_SECONDS = 60
SNAPSHOT_EVERY = 600
COLD_AFTER_DAYS = 180
_ready: dict = {}
_cache: dict = {}
_cache_lock = threading.Lock()


class PlatformCostMonth(Base):
    """One tenant's allocated cost and revenue for one calendar month (the trend's only source)."""
    __tablename__ = "platform_cost_months"
    __table_args__ = (UniqueConstraint("month", "tenant_id", name="uq_platform_cost_month"),)
    id = Column(Integer, primary_key=True)
    month = Column(Date, nullable=False, index=True)        # first day of the month
    tenant_id = Column(Integer, nullable=False, index=True)
    tenant_name = Column(String(200), nullable=False)
    compute = Column(Numeric(14, 2), nullable=False, default=0)
    database = Column(Numeric(14, 2), nullable=False, default=0)
    storage = Column(Numeric(14, 2), nullable=False, default=0)
    ai = Column(Numeric(14, 2), nullable=False, default=0)
    egress = Column(Numeric(14, 2), nullable=False, default=0)
    support = Column(Numeric(14, 2), nullable=False, default=0)
    original_mrr = Column(Numeric(14, 2), nullable=False, default=0)
    discount = Column(Numeric(14, 2), nullable=False, default=0)
    net_mrr = Column(Numeric(14, 2), nullable=False, default=0)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


def ensure_schema() -> None:
    if not _ready.get("schema"):
        PlatformCostMonth.__table__.create(bind=master_engine, checkfirst=True)
        _ready["schema"] = True


def money(v) -> Decimal:
    return Decimal(str(v or 0)).quantize(CENT, rounding=ROUND_HALF_UP)


def margin(net: Decimal, cost: Decimal) -> Optional[float]:
    """Gross margin % of net revenue; None when there is no revenue to divide by."""
    return round(float((net - cost) / net * 100), 1) if net > 0 else None


def _month_start(d: date, back: int = 0) -> date:
    y, m = d.year, d.month - back
    while m < 1:
        y, m = y - 1, m + 12
    return date(y, m, 1)


def _num(v) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


# ─── Cost pools ──────────────────────────────────────────────────────────────

def server_pools() -> dict:
    """Monthly cost of the live servers, by category, with how each server was split."""
    from app.services import platform_infrastructure as infra

    pools = {c: ZERO for c in POOL_CATS}
    servers, unpriced = [], []
    for e in infra.server_inventory():
        cost = _num(e.get("monthly_cost"))
        if not cost or cost <= 0:
            unpriced.append(e["name"])
            continue
        split = e.get("cost_split")
        shares = {k: _num(v) for k, v in split.items() if k in POOL_CATS and (_num(v) or 0) > 0} if isinstance(split, dict) else {}
        if shares:
            rule = "cost_split"
        elif e.get("db_host") and (e.get("local") or e.get("agent_url")):
            shares, rule = {"compute": 1, "database": 1}, "API + databases: half each"
        elif e.get("db_host"):
            shares, rule = {"database": 1}, "database server"
        else:
            shares, rule = {"compute": 1}, "application server"
        total = sum(shares.values())
        parts = {k: money(Decimal(str(cost)) * Decimal(str(v)) / Decimal(str(total))) for k, v in shares.items()}
        for k, v in parts.items():
            pools[k] += v
        servers.append({"name": e["name"], "region": e.get("region"), "monthly_cost": money(cost), "rule": rule, "split": parts})
    return {"pools": pools, "servers": servers, "unpriced": unpriced}


def rates(db: Session) -> dict:
    out = {k: Decimal(str(controls.value(db, key) or 0)) for k, key in RATE_KEYS.items()}
    out["cold"] = Decimal(str(controls.value(db, "costRateCold") or 0))
    out["support"] = Decimal(str(controls.value(db, "costSupport") or 0))
    out["budget"] = Decimal(str(controls.value(db, "costBudget") or 0)) * 100_000   # setting is in ₹ lakh
    return out


# ─── Measurements ────────────────────────────────────────────────────────────

def _meters(db: Session, since: date) -> dict[str, dict[str, float]]:
    """{slug: {meter: total}} for this month's api / ai / egress_kb – one grouped query."""
    from app.services import platform_usage

    platform_usage.ensure_schema()
    since_hour = int(datetime(since.year, since.month, since.day).timestamp() // 3600)
    rows = (db.query(PlatformTenantUsageHour.tenant_slug, PlatformTenantUsageHour.meter, func.sum(PlatformTenantUsageHour.value))
            .filter(PlatformTenantUsageHour.hour >= since_hour, PlatformTenantUsageHour.meter.in_(("api", "ai", "egress_kb")))
            .group_by(PlatformTenantUsageHour.tenant_slug, PlatformTenantUsageHour.meter).all())
    out: dict[str, dict[str, float]] = {}
    for slug, meter, v in rows:
        out.setdefault(slug, {})[meter] = float(v or 0)
    return out


def _db_sizes(db_names: set[str]) -> tuple[dict[str, float], list[str]]:
    """{database: MB} for the tenant databases, one grouped information_schema query per database server."""
    from app.services import platform_databases as dbs

    sizes: dict[str, float] = {}
    errors = []
    names = sorted(n for n in db_names if n)
    if not names:
        return sizes, errors
    marks = ", ".join(["%s"] * len(names))
    for entry in dbs.database_servers():
        try:
            conn = dbs._connect(entry)
        except Exception as exc:  # noqa: BLE001 – an unreachable server leaves its databases unmeasured
            errors.append(f"{entry['name']}: {exc.args[-1] if exc.args else exc}")
            continue
        try:
            with conn.cursor() as cur:
                cur.execute(f"SELECT table_schema, COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables "
                            f"WHERE table_schema IN ({marks}) GROUP BY table_schema", names)
                for schema, size in cur.fetchall():
                    sizes[schema] = max(sizes.get(schema, 0.0), float(size) / 1024 ** 2)   # a replica holds the same data
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{entry['name']}: {exc}")
        finally:
            conn.close()
    return sizes, errors


def _tickets(db: Session, since: date) -> dict[int, int]:
    from app.models.platform_support import PlatformSupportTicket as T

    rows = db.query(T.tenant_id, func.count(T.id)).filter(T.created_at >= datetime(since.year, since.month, since.day)).group_by(T.tenant_id).all()
    return {tid: int(n) for tid, n in rows}


def _resellers(db: Session) -> dict[int, tuple[str, Decimal]]:
    from app.models.platform_reseller import PlatformReseller, PlatformResellerTenant

    rows = (db.query(PlatformResellerTenant.tenant_id, PlatformReseller.name, PlatformReseller.commission_pct)
            .join(PlatformReseller, PlatformReseller.id == PlatformResellerTenant.reseller_id).all())
    return {tid: (name, Decimal(str(pct or 0))) for tid, name, pct in rows}


# ─── Allocation ──────────────────────────────────────────────────────────────

def allocate(pool: Decimal, weights: dict[int, float], fallback: list[int]) -> tuple[dict[int, Decimal], str]:
    """Split ``pool`` by weight; evenly over ``fallback`` when nothing was measured. Rounding is settled on the largest
    share so the parts always add up to the pool."""
    if pool <= 0:
        return {}, "none"
    measured = {k: w for k, w in weights.items() if w > 0}
    basis = "measured"
    if not measured:
        if not fallback:
            return {}, "unallocated"
        measured, basis = {k: 1.0 for k in fallback}, "even"
    total = sum(measured.values())
    out = {k: money(pool * Decimal(str(w / total))) for k, w in measured.items()}
    diff = pool - sum(out.values(), ZERO)
    if diff:
        top = max(out, key=lambda k: out[k])
        out[top] += diff
    return out, basis


def _discounts(db: Session, tenants: list[Tenant], prices: dict[int, dict], addon: dict[int, Decimal], today: date) -> dict[int, dict]:
    """Per tenant: original MRR and this month's discount by kind (see module doc)."""
    from app.services import platform_discounts as dc

    paying = [t for t in tenants if billing.is_paying(t) and prices[t.id]["monthly"] > 0]
    ctx = dc.context(db, [t.id for t in paying])
    cycles = controls.tenant_values(db, "invCycle", [t.id for t in paying])
    partners = _resellers(db)
    paying_ids = {t.id for t in paying}
    out = {}
    for t in tenants:
        kinds = {k: ZERO for k in DISCOUNT_KINDS}
        row = {"subscription": ZERO, "addons": ZERO, "original": ZERO, "kinds": kinds, "discount": ZERO, "lines": [], "partner": None, "cycle": None}
        out[t.id] = row
        if t.id not in paying_ids:
            continue
        monthly, extra = prices[t.id]["monthly"], addon.get(t.id, ZERO)
        cycle = cycles.get(t.id) or "Annual"
        start, end = billing.period_for(today, cycle)
        n = billing.CYCLE_MONTHS.get(cycle, 12)
        has_yearly = cycle == "Annual" and prices[t.id]["yearly"] > 0
        priced = dc.price(ctx, t, cycle, start, end, money(monthly * n), has_yearly)
        for line in priced["lines"]:
            key = line["key"]
            kind = "negotiated" if key.startswith("neg:") else "coupon" if key.startswith("cp:") else key
            amount = line["amount"] / n
            kinds[kind] += amount
            row["lines"].append({"kind": kind, "label": line["label"], "monthly": money(amount)})
        for k in ("coupon", "volume", "negotiated", "annual"):
            kinds[k] = money(kinds[k])
        before_partner = max(monthly + extra - sum(kinds.values(), ZERO), ZERO)
        if t.id in partners and partners[t.id][1] > 0:
            name, pct = partners[t.id]
            kinds["partner"] = money(before_partner * pct / 100)
            row["partner"] = {"reseller": name, "pct": float(pct)}
            row["lines"].append({"kind": "partner", "label": f"Partner commission {pct:g}% ({name})", "monthly": kinds["partner"]})
        row.update(subscription=monthly, addons=extra, original=money(monthly + extra), discount=min(sum(kinds.values(), ZERO), money(monthly + extra)),
                   cycle=cycle, notes=priced["notes"])
    return out


def compute(db: Session, today: Optional[date] = None) -> dict:
    """Every tenant's cost and revenue for the current month (all tenants – callers filter by scope)."""
    from app.services import platform_addons as addons

    today = today or date.today()
    month = _month_start(today)
    tenants = db.query(Tenant).order_by(Tenant.name).all()
    ids = [t.id for t in tenants]
    live = [t.id for t in tenants if t.status in ("active", "trial")]
    sp = server_pools()
    r = rates(db)
    meters = _meters(db, month)
    sizes, db_errors = _db_sizes({t.db_name for t in tenants})
    tickets = _tickets(db, month)
    prices = billing.tenant_prices(db, tenants)
    addons.ensure_schema()
    addon = addons.addon_mrr_by_tenant(db, ids)
    revenue = _discounts(db, tenants, prices, addon, today)

    m = lambda t, k: meters.get(t.slug, {}).get(k, 0.0)  # noqa: E731
    measures = {
        "compute": {t.id: m(t, "api") for t in tenants},
        "database": {t.id: sizes.get(t.db_name, 0.0) for t in tenants},
        "storage": {t.id: float(t.used_storage or 0) for t in tenants},
        "ai": {t.id: m(t, "ai") for t in tenants},
        "egress": {t.id: m(t, "egress_kb") for t in tenants},
        "support": {t.id: float(tickets.get(t.id, 0)) for t in tenants},
    }
    alloc, basis = {}, {}
    for c in POOL_CATS:
        alloc[c], basis[c] = allocate(sp["pools"][c], measures[c], live)
    alloc["support"], basis["support"] = allocate(money(r["support"]), measures["support"], live)
    usage_cost = {  # unit rates on the tenant's own consumption
        "storage": {t.id: money(Decimal(str(measures["storage"][t.id])) / 1024 * r["storage"]) for t in tenants},
        "ai": {t.id: money(Decimal(str(measures["ai"][t.id])) * r["ai"]) for t in tenants},
        "egress": {t.id: money(Decimal(str(measures["egress"][t.id])) / 1024 ** 2 * r["egress"]) for t in tenants},
    }
    rows = []
    for t in tenants:
        cost = {c: alloc[c].get(t.id, ZERO) + usage_cost.get(c, {}).get(t.id, ZERO) for c in CATS}
        total = sum(cost.values(), ZERO)
        rv = revenue[t.id]
        net = rv["original"] - rv["discount"]
        rows.append({"id": t.id, "name": t.name, "slug": t.slug, "status": t.status, "billing_status": t.billing_status, "paying": rv["original"] > 0,
                     **cost, "total": total, "subscription": rv["subscription"], "addons": rv["addons"], "mrr": rv["original"],
                     "discount": rv["discount"], "discounts": rv["kinds"], "discount_lines": rv["lines"], "partner": rv["partner"], "cycle": rv["cycle"],
                     "net_mrr": net, "profit": net - total, "margin": margin(net, total),
                     "usage": {"api": measures["compute"][t.id], "db_mb": round(measures["database"][t.id], 2), "storage_mb": round(measures["storage"][t.id], 2),
                               "ai": measures["ai"][t.id], "egress_mb": round(measures["egress"][t.id] / 1024, 2), "tickets": int(measures["support"][t.id])}})
    return {"month": month, "computed_at": datetime.utcnow(), "rows": rows, "servers": sp["servers"], "unpriced": sp["unpriced"],
            "pools": sp["pools"], "rates": r, "basis": basis, "db_errors": db_errors}


def cached(refresh: bool = False) -> dict:
    """compute() shared for a minute across requests (KPIs, table pages and export read the same figures)."""
    with _cache_lock:
        hit = _cache.get("data")
        if hit and not refresh and time.time() - _cache["at"] < CACHE_SECONDS:
            return hit
        db = MasterSessionLocal()
        try:
            data = compute(db)
        finally:
            db.close()
        _cache.update(data=data, at=time.time())
    try:
        snapshot(data, force=refresh)
    except Exception:  # noqa: BLE001 – the page still shows live figures
        logger.exception("Cost & margin: monthly snapshot failed")
    return data


def scoped(data: dict, scope: Optional[set[int]]) -> list[dict]:
    return data["rows"] if scope is None else [r for r in data["rows"] if r["id"] in scope]


# ─── History ─────────────────────────────────────────────────────────────────

_UPSERT = text(
    "INSERT INTO platform_cost_months (month, tenant_id, tenant_name, compute, `database`, storage, ai, egress, support, original_mrr, discount, net_mrr, updated_at) "
    "VALUES (:month, :tenant_id, :tenant_name, :compute, :database, :storage, :ai, :egress, :support, :original_mrr, :discount, :net_mrr, :updated_at) "
    "ON DUPLICATE KEY UPDATE tenant_name = VALUES(tenant_name), compute = VALUES(compute), `database` = VALUES(`database`), storage = VALUES(storage), "
    "ai = VALUES(ai), egress = VALUES(egress), support = VALUES(support), original_mrr = VALUES(original_mrr), discount = VALUES(discount), "
    "net_mrr = VALUES(net_mrr), updated_at = VALUES(updated_at)")


def snapshot(data: dict, force: bool = False) -> bool:
    """Write the current month's figures (at most every 10 minutes per worker unless forced)."""
    if not force and time.time() - _ready.get("snap_at", 0) < SNAPSHOT_EVERY:
        return False
    ensure_schema()
    now = datetime.utcnow()
    rows = [{"month": data["month"], "tenant_id": r["id"], "tenant_name": r["name"][:200], **{c: r[c] for c in CATS},
             "original_mrr": r["mrr"], "discount": r["discount"], "net_mrr": r["net_mrr"], "updated_at": now} for r in data["rows"]]
    if rows:
        with master_engine.begin() as conn:
            conn.execute(_UPSERT, rows)
    _ready["snap_at"] = time.time()
    return True


def trend(db: Session, scope: Optional[set[int]], month: date, months: int = 6) -> dict:
    ensure_schema()
    first = _month_start(month, months - 1)
    q = (db.query(PlatformCostMonth.month,
                  func.sum(PlatformCostMonth.compute + PlatformCostMonth.database + PlatformCostMonth.storage + PlatformCostMonth.ai
                           + PlatformCostMonth.egress + PlatformCostMonth.support),
                  func.sum(PlatformCostMonth.net_mrr), func.sum(PlatformCostMonth.original_mrr), func.sum(PlatformCostMonth.discount))
         .filter(PlatformCostMonth.month >= first, PlatformCostMonth.month <= month))
    if scope is not None:
        q = q.filter(PlatformCostMonth.tenant_id.in_(list(scope) or [0]))
    found = {m: (money(c), money(n), money(o), money(d)) for m, c, n, o, d in q.group_by(PlatformCostMonth.month).all()}
    labels, cost, net, orig, disc = [], [], [], [], []
    for back in range(months - 1, -1, -1):
        m = _month_start(month, back)
        labels.append(m.strftime("%b"))
        v = found.get(m)
        cost.append(v[0] if v else None)
        net.append(v[1] if v else None)
        orig.append(v[2] if v else None)
        disc.append(v[3] if v else None)
    since = min(found) if found else None
    return {"labels": labels, "cost": cost, "net_revenue": net, "original_revenue": orig, "discount": disc, "since": since}


# ─── Summary ─────────────────────────────────────────────────────────────────

def summary(db: Session, data: dict, scope: Optional[set[int]]) -> dict:
    rows = scoped(data, scope)
    cats = {c: sum((r[c] for r in rows), ZERO) for c in CATS}
    cost = sum(cats.values(), ZERO)
    orig = sum((r["mrr"] for r in rows), ZERO)
    disc = sum((r["discount"] for r in rows), ZERO)
    net = orig - disc
    by_kind = {k: sum((r["discounts"][k] for r in rows), ZERO) for k in DISCOUNT_KINDS}
    tr = trend(db, scope, data["month"])
    prev = _month_start(data["month"], 1)
    prev_row = db.query(func.sum(PlatformCostMonth.compute + PlatformCostMonth.database + PlatformCostMonth.storage + PlatformCostMonth.ai
                                 + PlatformCostMonth.egress + PlatformCostMonth.support), func.sum(PlatformCostMonth.net_mrr)) \
        .filter(PlatformCostMonth.month == prev, *([PlatformCostMonth.tenant_id.in_(list(scope) or [0])] if scope is not None else [])).first()
    prev_margin = margin(money(prev_row[1]), money(prev_row[0])) if prev_row and prev_row[1] is not None else None
    gm = margin(net, cost)
    budget = data["rates"]["budget"]
    r = data["rates"]
    return {
        "month": data["month"], "computed_at": data["computed_at"], "tenants": len(rows),
        "kpis": {"cost": cost, "original_mrr": orig, "discount": disc, "net_mrr": net, "profit": net - cost, "margin": gm,
                 "margin_change": round(gm - prev_margin, 1) if gm is not None and prev_margin is not None else None,
                 "avg_cost": money(cost / len(rows)) if rows else None,
                 # budget is platform-wide, so it is compared with every tenant's cost, not just the caller's scope
                 "budget": budget, "budget_used": round(float(sum((x["total"] for x in data["rows"]), ZERO) / budget * 100), 1) if budget > 0 else None,
                 "budget_alert": bool(controls.value(db, "costAlert"))},
        "mix": [{"key": c, "label": CAT_LABELS[c], "value": cats[c]} for c in CATS],
        "discounts": [{"key": k, "label": DISCOUNT_LABELS[k], "value": by_kind[k]} for k in DISCOUNT_KINDS],
        "trend": tr,
        "sources": {"servers": data["servers"], "unpriced": data["unpriced"], "basis": data["basis"], "db_errors": data["db_errors"],
                    "rates": {"storage_gb": r["storage"], "cold_gb": r["cold"], "ai_question": r["ai"], "egress_gb": r["egress"], "support_month": r["support"]}},
    }


SORTS = {"t": "name", "cp": "compute", "db": "database", "st": "storage", "ai": "ai", "eg": "egress", "tt": "total", "m": "mrr",
         "dc": "discount", "nm": "net_mrr", "gp": "profit", "gm": "margin"}


def page(rows: list[dict], q: str, sort: str, offset: int, limit: int) -> dict:
    q = (q or "").strip().lower()
    items = [r for r in rows if not q or q in r["name"].lower() or q in r["slug"].lower()]
    for part in reversed([p for p in (sort or "").split(",") if ":" in p]):   # stable sorts, last key first
        k, d = part.split(":", 1)
        field = SORTS.get(k)
        if field:
            known = [r for r in items if r[field] is not None]
            known.sort(key=lambda r: r[field].lower() if isinstance(r[field], str) else r[field], reverse=d.strip() == "-1")
            items = known + [r for r in items if r[field] is None]   # no margin (no revenue) always sorts last
    totals = {k: sum((r[k] for r in items), ZERO) for k in (*CATS, "total", "mrr", "discount", "net_mrr", "profit")}
    totals["margin"] = margin(totals["net_mrr"], totals["total"])
    return {"items": items[offset:offset + limit], "total": len(items), "offset": offset, "limit": limit, "totals": totals}


# ─── Savings opportunities ───────────────────────────────────────────────────

def savings(db: Session, data: dict, scope: Optional[set[int]]) -> list[dict]:
    """Optimisations backed by an existing action (Documents & storage policies), sized from the storage catalogue."""
    from app.models.platform_storage import PlatformStorageFile as F
    from app.services import platform_storage as storage

    storage.ensure_schema()
    r = data["rates"]
    slugs = None if scope is None else [x["slug"] for x in data["rows"] if x["id"] in scope]
    base = db.query(func.count(F.id), func.coalesce(func.sum(F.size_bytes), 0)).filter(F.quarantined == False)  # noqa: E712
    if slugs is not None:
        base = base.filter(F.tenant_slug.in_(slugs or [""]))
    out = []

    cutoff = datetime.utcnow() - timedelta(days=COLD_AFTER_DAYS)
    # same selection as the cold-tier policy (platform_storage._run_cold)
    n, size = base.filter(F.cold == False, F.root == "media", or_(F.uploaded_at.is_(None), F.uploaded_at < cutoff),  # noqa: E712
                          or_(F.last_accessed_at.is_(None), F.last_accessed_at < cutoff)).first()
    total_n, total_size = base.first()
    if n:
        gb = Decimal(size) / 1024 ** 3
        pct = round(100 * size / total_size) if total_size else 0
        out.append(_opportunity(db, "cold_180", f"Move {pct}% of files ({n:,}) untouched for {COLD_AFTER_DAYS} days to cold storage",
                                money(gb * (r["storage"] - r["cold"])) if r["storage"] > r["cold"] else None, gb,
                                "the storage rate is not above the cold-storage rate" if r["storage"] <= r["cold"] else None))

    dup = db.query(F.tenant_slug, F.sha256, func.count(F.id), func.sum(F.size_bytes), func.sum(F.shared_bytes), func.max(F.size_bytes)) \
        .filter(F.sha256.isnot(None), F.quarantined == False)  # noqa: E712
    if slugs is not None:
        dup = dup.filter(F.tenant_slug.in_(slugs or [""]))
    extra, copies = 0, 0
    for _slug, _h, cnt, total, shared, one in dup.group_by(F.tenant_slug, F.sha256).having(func.count(F.id) > 1).all():
        waste = int(total or 0) - int(shared or 0) - int(one or 0)   # bytes beyond one copy that are not hard links yet
        if waste > 0:
            extra += waste
            copies += int(cnt) - 1
    if extra:
        gb = Decimal(extra) / 1024 ** 3
        out.append(_opportunity(db, "dedup", f"De-duplicate {copies:,} identical upload(s)", money(gb * r["storage"]) if r["storage"] > 0 else None, gb,
                                "no storage rate is set" if r["storage"] <= 0 else None))
    return out


def _opportunity(db: Session, policy: str, title: str, saving: Optional[Decimal], gb: Decimal, why_no_saving: Optional[str]) -> dict:
    from app.services import platform_storage as storage

    return {"key": policy, "title": title, "saving": saving, "gb": round(float(gb), 2), "saving_note": why_no_saving,
            "action": {"kind": "storage_policy", "policy": policy, "label": storage.POLICY_LABELS[policy]},
            "enabled": storage.policy_enabled(db, policy), "unavailable": storage.policy_availability(policy)}


# ─── Export ──────────────────────────────────────────────────────────────────

def workbook(db: Session, data: dict, scope: Optional[set[int]], actor: str) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    s = summary(db, data, scope)
    rows = sorted(scoped(data, scope), key=lambda r: r["name"].lower())
    k = s["kpis"]
    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"
    bold = Font(bold=True)
    ws.append(["Cost & margin report", f"{data['month']:%B %Y}"])
    ws["A1"].font = Font(bold=True, size=13)
    ws.append(["Generated", datetime.utcnow().strftime("%d %b %Y %H:%M UTC"), "by", actor])
    ws.append(["Tenants", len(rows)])
    ws.append([])
    for label, value in (("Infra + support cost / month (₹)", k["cost"]), ("Original MRR (₹, excl. GST)", k["original_mrr"]), ("Discounts (₹ / month)", k["discount"]),
                         ("Net MRR (₹)", k["net_mrr"]), ("Gross profit (₹)", k["profit"]), ("Gross margin (%)", k["margin"]),
                         ("Avg cost / tenant (₹)", k["avg_cost"]), ("Monthly infra budget (₹)", k["budget"] or None), ("Budget used (%)", k["budget_used"])):
        ws.append([label, float(value) if isinstance(value, Decimal) else value])
    ws.append([])
    ws.append(["Cost by category", "₹ / month"])
    ws.cell(ws.max_row, 1).font = bold
    for m in s["mix"]:
        ws.append([m["label"], float(m["value"])])
    ws.append([])
    ws.append(["Discounts by kind", "₹ / month"])
    ws.cell(ws.max_row, 1).font = bold
    for d in s["discounts"]:
        ws.append([d["label"], float(d["value"])])
    ws.append([])
    ws.append(["Allocation rules"])
    ws.cell(ws.max_row, 1).font = bold
    for line in (__doc__ or "").strip().splitlines()[2:]:
        ws.append([line.rstrip()])
    ws.column_dimensions["A"].width = 42
    ws.column_dimensions["B"].width = 18

    t = wb.create_sheet("Tenants")
    head = ["Tenant", "Status", "Compute", "Database", "Storage", "AI", "Egress", "Support", "Total cost", "Subscription", "Add-ons", "Original MRR",
            "Coupon", "Volume", "Negotiated", "Partner", "Annual prepay", "Discount", "Net MRR", "Gross profit", "Gross margin %"]
    t.append(head)
    for c in t[1]:
        c.font = bold
    for r in rows:
        d = r["discounts"]
        t.append([r["name"], r["status"], *(float(r[c]) for c in CATS), float(r["total"]), float(r["subscription"]), float(r["addons"]), float(r["mrr"]),
                  *(float(d[x]) for x in DISCOUNT_KINDS), float(r["discount"]), float(r["net_mrr"]), float(r["profit"]), r["margin"]])
    t.append(["Total", "", *(float(sum((r[c] for r in rows), ZERO)) for c in (*CATS, "total", "subscription", "addons", "mrr")),
              *(float(sum((r["discounts"][x] for r in rows), ZERO)) for x in DISCOUNT_KINDS),
              float(k["discount"]), float(k["net_mrr"]), float(k["profit"]), k["margin"]])
    for c in t[t.max_row]:
        c.font = bold
    t.column_dimensions["A"].width = 32
    t.freeze_panes = "B2"

    dl = wb.create_sheet("Discount lines")
    dl.append(["Tenant", "Kind", "Discount", "₹ / month"])
    for c in dl[1]:
        c.font = bold
    for r in rows:
        for line in r["discount_lines"]:
            dl.append([r["name"], DISCOUNT_LABELS[line["kind"]], line["label"], float(line["monthly"])])
    dl.column_dimensions["A"].width = 32
    dl.column_dimensions["C"].width = 60

    u = wb.create_sheet("Measurements")
    u.append(["Tenant", "API requests", "Database MB", "Storage MB", "AI questions", "Egress MB", "Support tickets"])
    for c in u[1]:
        c.font = bold
    for r in rows:
        x = r["usage"]
        u.append([r["name"], x["api"], x["db_mb"], x["storage_mb"], x["ai"], x["egress_mb"], x["tickets"]])
    u.append([])
    u.append(["Server", "Region", "Monthly cost", "Rule", "Split"])
    for c in u[u.max_row]:
        c.font = bold
    for sv in data["servers"]:
        u.append([sv["name"], sv["region"], float(sv["monthly_cost"]), sv["rule"], ", ".join(f"{CAT_LABELS[a]} {float(b):,.2f}" for a, b in sv["split"].items())])
    u.column_dimensions["A"].width = 32

    tr = wb.create_sheet("Trend")
    tr.append(["Month", "Cost", "Original revenue", "Discount", "Net revenue"])
    for c in tr[1]:
        c.font = bold
    for i, label in enumerate(s["trend"]["labels"]):
        vals = [s["trend"][key][i] for key in ("cost", "original_revenue", "discount", "net_revenue")]
        tr.append([label, *(float(v) if v is not None else None for v in vals)])

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ─── Worker ──────────────────────────────────────────────────────────────────

def start_worker(interval: int = 3600) -> None:
    """Hourly snapshot so each month's row is current even when nobody opens the page near month end."""
    if _ready.get("worker"):
        return
    stop = threading.Event()

    def loop():
        while not stop.wait(interval):
            try:
                cached(refresh=True)
            except Exception:  # noqa: BLE001
                logger.exception("Cost & margin snapshot failed")
    threading.Thread(target=loop, daemon=True, name="cost-margin").start()
    _ready["worker"] = stop
