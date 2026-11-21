import io
import os
from datetime import date, datetime
from decimal import Decimal
from types import SimpleNamespace as NS

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("DEBUG", "false")

from app.services import platform_addons as addons
from app.services import platform_billing as billing
from app.services import platform_controls as controls
from app.services import platform_discounts as dc
from app.services import platform_finops as fo

D = Decimal
TODAY = date(2026, 11, 4)
RULES = {"volume": True, "couponMax": 50, "dcAnnual": 0, "dcStackVol": False, "dcNegReplace": True, "dcShowInv": True}


def tenant(id, status="active", billing_status="active", seats=10, name=None, plan_id=1, used=0.0):
    return NS(id=id, name=name or f"T{id}", slug=f"t{id}", db_name=f"digitcrm_t{id}", status=status, billing_status=billing_status,
              max_users=seats, plan_id=plan_id, used_storage=used)


def tier(f, t, p):
    return NS(from_seats=f, to_seats=t, pct=D(p))


def coupon(id, tid, kind="percent", value=10, duration="forever", redeemed=datetime(2026, 10, 1), code=None, first_invoice_id=None):
    return NS(id=id, tenant_id=tid, kind=kind, value=D(value), duration=duration, redeemed_at=redeemed, code=code or f"C{id}", first_invoice_id=first_invoice_id)


def negotiated(id, tid, pct, start=date(2026, 6, 1), term=12):
    return NS(id=id, tenant_id=tid, pct=D(pct), starts_on=start, valid_until=date(2027, 5, 31), term_months=term)


def prices(monthly=10000, yearly=0):
    return {"plan": None, "monthly": D(monthly), "yearly": D(yearly), "source": "plan"}


def run_discounts(monkeypatch, tenants, *, tiers=(), neg=(), reds=(), rules=None, cycles=None, partners=None, price=None, addon=None):
    ctx = dc.Context(tiers=list(tiers), negotiated={n.tenant_id: n for n in neg}, redemptions={}, rules={**RULES, **(rules or {})})
    for r in reds:
        ctx.redemptions.setdefault(r.tenant_id, []).append(r)
    monkeypatch.setattr(dc, "context", lambda db, ids: ctx)
    monkeypatch.setattr(controls, "tenant_values", lambda db, key, ids: {i: (cycles or {}).get(i, "Monthly") for i in ids})
    monkeypatch.setattr(fo, "_resellers", lambda db: partners or {})
    p = {t.id: (price or {}).get(t.id, prices()) for t in tenants}
    return fo._discounts(None, tenants, p, addon or {}, TODAY)


# ─── Allocation and margin ───────────────────────────────────────────────────

def test_allocate_by_measurement_sums_exactly_to_pool():
    out, basis = fo.allocate(D("1000.00"), {1: 1, 2: 1, 3: 1}, [1, 2, 3])
    assert basis == "measured"
    assert sum(out.values()) == D("1000.00")
    assert sorted(out.values()) == [D("333.33"), D("333.33"), D("333.34")]


def test_allocate_is_proportional_and_skips_unmeasured():
    out, _ = fo.allocate(D("900"), {1: 200, 2: 100, 3: 0}, [1, 2, 3])
    assert out == {1: D("600.00"), 2: D("300.00")}


def test_allocate_falls_back_to_even_split_when_nothing_measured():
    out, basis = fo.allocate(D("100"), {1: 0, 2: 0}, [1, 2])
    assert basis == "even" and out == {1: D("50.00"), 2: D("50.00")}


def test_allocate_empty_pool():
    assert fo.allocate(D("0"), {1: 5}, [1]) == ({}, "none")
    assert fo.allocate(D("10"), {}, []) == ({}, "unallocated")


def test_margin_handles_zero_and_negative():
    assert fo.margin(D("0"), D("500")) is None
    assert fo.margin(D("1000"), D("250")) == 75.0
    assert fo.margin(D("1000"), D("1500")) == -50.0


# ─── Discounts (existing engine, eligibility and stacking) ───────────────────

def test_non_paying_tenants_get_no_revenue_or_discount(monkeypatch):
    out = run_discounts(monkeypatch, [tenant(1, status="trial", billing_status="trial")], tiers=[tier(1, None, 10)])
    assert out[1]["original"] == 0 and out[1]["discount"] == 0


def test_coupon_replaces_volume_unless_stacking_is_on(monkeypatch):
    t = tenant(1, seats=30)
    out = run_discounts(monkeypatch, [t], tiers=[tier(1, 25, 0), tier(26, 75, 5)], reds=[coupon(1, 1, value=10)])
    assert out[1]["kinds"]["coupon"] == D("1000.00") and out[1]["kinds"]["volume"] == 0
    out = run_discounts(monkeypatch, [t], tiers=[tier(1, 25, 0), tier(26, 75, 5)], reds=[coupon(1, 1, value=10)], rules={"dcStackVol": True})
    assert out[1]["kinds"]["coupon"] == D("1000.00") and out[1]["kinds"]["volume"] == D("500.00")
    assert out[1]["discount"] == D("1500.00")


def test_negotiated_replaces_volume_and_cap_applies(monkeypatch):
    t = tenant(1, seats=30)
    out = run_discounts(monkeypatch, [t], tiers=[tier(26, 75, 5)], neg=[negotiated(1, 1, 15)])
    assert out[1]["kinds"]["negotiated"] == D("1500.00") and out[1]["kinds"]["volume"] == 0
    # 15% negotiated + 10% coupon capped at 20%: scaled proportionally, never more than the cap in total
    out = run_discounts(monkeypatch, [t], neg=[negotiated(1, 1, 15)], reds=[coupon(1, 1, value=10)], rules={"couponMax": 20})
    assert out[1]["discount"] == D("2000.00")
    assert out[1]["kinds"]["negotiated"] == D("1200.00") and out[1]["kinds"]["coupon"] == D("800.00")


def test_expired_repeating_coupon_is_not_applied(monkeypatch):
    out = run_discounts(monkeypatch, [tenant(1)], reds=[coupon(1, 1, duration="repeat_3", redeemed=datetime(2026, 1, 10))])
    assert out[1]["discount"] == 0


def test_annual_prepay_only_on_annual_cycle_without_yearly_price(monkeypatch):
    t = tenant(1)
    out = run_discounts(monkeypatch, [t], rules={"dcAnnual": 10}, cycles={1: "Annual"})
    assert out[1]["kinds"]["annual"] == D("1000.00")
    out = run_discounts(monkeypatch, [t], rules={"dcAnnual": 10}, cycles={1: "Annual"}, price={1: prices(10000, 100000)})
    assert out[1]["kinds"]["annual"] == 0
    out = run_discounts(monkeypatch, [t], rules={"dcAnnual": 10}, cycles={1: "Monthly"})
    assert out[1]["kinds"]["annual"] == 0


def test_fixed_once_coupon_is_spread_over_the_billing_period(monkeypatch):
    out = run_discounts(monkeypatch, [tenant(1)], reds=[coupon(1, 1, kind="amount", value=12000, duration="once")], cycles={1: "Annual"})
    assert out[1]["kinds"]["coupon"] == D("1000.00")   # ₹12,000 off the annual invoice = ₹1,000 a month
    out = run_discounts(monkeypatch, [tenant(1)], reds=[coupon(1, 1, kind="amount", value=12000, duration="once", first_invoice_id=7)], cycles={1: "Annual"})
    assert out[1]["discount"] == 0                      # already used on an invoice


def test_partner_commission_is_on_the_remainder_so_nothing_is_deducted_twice(monkeypatch):
    out = run_discounts(monkeypatch, [tenant(1)], reds=[coupon(1, 1, value=10)], partners={1: ("Acme Partners", D("20"))}, addon={1: D("1000")})
    k = out[1]["kinds"]
    assert out[1]["original"] == D("11000.00")          # subscription 10,000 + add-ons 1,000
    assert k["coupon"] == D("1000.00")                  # coupons apply to the subscription only
    assert k["partner"] == D("2000.00")                 # 20% of (11,000 − 1,000)
    assert out[1]["discount"] == D("3000.00")
    assert {l["kind"] for l in out[1]["lines"]} == {"coupon", "partner"}


def test_discount_never_exceeds_original(monkeypatch):
    out = run_discounts(monkeypatch, [tenant(1)], reds=[coupon(1, 1, value=100)], partners={1: ("P", D("50"))}, rules={"couponMax": 100})
    assert out[1]["discount"] == out[1]["original"] == D("10000.00")


# ─── End-to-end month ────────────────────────────────────────────────────────

class FakeQuery:
    def __init__(self, items):
        self.items = items

    def order_by(self, *_):
        return self

    def all(self):
        return self.items


@pytest.fixture
def month(monkeypatch):
    tenants = [tenant(1, seats=10, used=2048.0, name="Alpha"), tenant(2, status="trial", billing_status="trial", used=1024.0, name="Beta"),
               tenant(3, name="Gamma")]
    monkeypatch.setattr(fo, "server_pools", lambda: {"pools": {"compute": D("30000"), "database": D("10000"), "storage": D("0"), "ai": D("0"), "egress": D("0")},
                                                    "servers": [{"name": "app-1", "region": "On-premise", "monthly_cost": D("40000"), "rule": "cost_split", "split": {"compute": D("30000"), "database": D("10000")}}], "unpriced": []})
    monkeypatch.setattr(fo, "rates", lambda db: {"storage": D("100"), "cold": D("20"), "ai": D("2"), "egress": D("10"), "support": D("6000"), "budget": D("100000")})
    monkeypatch.setattr(fo, "_meters", lambda db, since: {"t1": {"api": 2000, "ai": 50, "egress_kb": 1024 ** 2}, "t2": {"api": 1000}})
    monkeypatch.setattr(fo, "_db_sizes", lambda names: ({"digitcrm_t1": 300.0, "digitcrm_t2": 100.0, "digitcrm_t3": 100.0}, []))
    monkeypatch.setattr(fo, "_tickets", lambda db, since: {3: 2})
    monkeypatch.setattr(billing, "tenant_prices", lambda db, ts: {t.id: prices(20000 if t.id == 1 else 5000) for t in ts})
    monkeypatch.setattr(addons, "ensure_schema", lambda: None)
    monkeypatch.setattr(addons, "addon_mrr_by_tenant", lambda db, ids: {})
    ctx = dc.Context(tiers=[], negotiated={}, redemptions={1: [coupon(1, 1, value=10)]}, rules=dict(RULES))
    monkeypatch.setattr(dc, "context", lambda db, ids: ctx)
    monkeypatch.setattr(controls, "tenant_values", lambda db, key, ids: {i: "Monthly" for i in ids})
    monkeypatch.setattr(fo, "_resellers", lambda db: {})
    db = NS(query=lambda model: FakeQuery(tenants))
    return fo.compute(db, TODAY)


def test_compute_allocates_costs_and_margins(month):
    r = {x["id"]: x for x in month["rows"]}
    # compute pool by API share 2000:1000:0, database by size 300:100:100, support all to the tenant with tickets
    assert (r[1]["compute"], r[2]["compute"], r[3]["compute"]) == (D("20000.00"), D("10000.00"), 0)
    assert (r[1]["database"], r[2]["database"], r[3]["database"]) == (D("6000.00"), D("2000.00"), D("2000.00"))
    assert r[3]["support"] == D("6000.00") and r[1]["support"] == 0
    # metered rates: 2 GB storage × ₹100, 50 questions × ₹2, 1 GB egress × ₹10
    assert (r[1]["storage"], r[1]["ai"], r[1]["egress"]) == (D("200.00"), D("100.00"), D("10.00"))
    assert r[1]["total"] == D("26310.00")
    assert r[1]["mrr"] == D("20000.00") and r[1]["discount"] == D("2000.00") and r[1]["net_mrr"] == D("18000.00")
    assert r[1]["profit"] == D("-8310.00") and r[1]["margin"] == round(-8310 / 18000 * 100, 1)
    assert r[2]["mrr"] == 0 and r[2]["margin"] is None          # trial: costs, no revenue, no margin
    assert sum(x["compute"] + x["database"] + x["support"] for x in month["rows"]) == D("46000.00")   # pools fully allocated


def test_page_sorts_with_missing_margin_last_and_totals(month):
    p = fo.page(month["rows"], "", "gm:-1", 0, 10)
    assert [x["name"] for x in p["items"]][-1] == "Beta"
    p = fo.page(month["rows"], "", "gm:1", 0, 10)
    assert [x["name"] for x in p["items"]][-1] == "Beta"
    p = fo.page(month["rows"], "", "tt:-1", 0, 1)
    assert p["total"] == 3 and p["items"][0]["name"] == "Alpha"
    assert p["totals"]["net_mrr"] == D("23000.00")
    assert p["totals"]["margin"] == fo.margin(p["totals"]["net_mrr"], p["totals"]["total"])
    assert fo.page(month["rows"], "gam", "", 0, 10)["total"] == 1


def test_scope_filters_rows_without_changing_allocation(month):
    rows = fo.scoped(month, {1})
    assert len(rows) == 1 and rows[0]["compute"] == D("20000.00")


# ─── History, summary and export (SQLite) ────────────────────────────────────

@pytest.fixture
def sqlite_db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    fo.PlatformCostMonth.__table__.create(bind=engine)
    monkeypatch.setitem(fo._ready, "schema", True)
    monkeypatch.setattr(controls, "value", lambda db, key, tenant_id=None: True)
    db = sessionmaker(bind=engine)()
    yield db
    db.close()


def _snap(db, m, tid, cost, net, orig=None, disc=0):
    db.add(fo.PlatformCostMonth(month=m, tenant_id=tid, tenant_name=f"T{tid}", compute=cost, database=0, storage=0, ai=0, egress=0, support=0,
                                original_mrr=orig if orig is not None else net, discount=disc, net_mrr=net))


def test_trend_reads_recorded_months_only(sqlite_db):
    _snap(sqlite_db, date(2026, 9, 1), 1, 1000, 4000)
    _snap(sqlite_db, date(2026, 11, 1), 1, 1500, 5000, 5500, 500)
    _snap(sqlite_db, date(2026, 11, 1), 2, 500, 0)
    sqlite_db.commit()
    tr = fo.trend(sqlite_db, None, date(2026, 11, 1))
    assert tr["labels"] == ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov"]
    assert tr["cost"] == [None, None, None, D("1000.00"), None, D("2000.00")]
    assert tr["net_revenue"][-1] == D("5000.00") and tr["discount"][-1] == D("500.00")
    assert fo.trend(sqlite_db, {2}, date(2026, 11, 1))["net_revenue"][-1] == 0
    assert tr["since"] == date(2026, 9, 1)


def test_summary_and_workbook(month, sqlite_db):
    _snap(sqlite_db, date(2026, 10, 1), 1, 1000, 2000)      # previous month: 50% margin
    sqlite_db.commit()
    s = fo.summary(sqlite_db, month, None)
    k = s["kpis"]
    assert k["cost"] == sum(r["total"] for r in month["rows"])
    assert k["net_mrr"] == k["original_mrr"] - k["discount"] == D("23000.00")
    assert k["margin"] == fo.margin(k["net_mrr"], k["cost"])
    assert k["margin_change"] == round(k["margin"] - 50.0, 1)
    assert k["avg_cost"] == fo.money(k["cost"] / 3)
    assert k["budget_used"] == round(float(k["cost"] / D("100000") * 100), 1)
    assert [m["key"] for m in s["mix"]] == list(fo.CATS)
    assert next(d for d in s["discounts"] if d["key"] == "coupon")["value"] == D("2000.00")

    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(fo.workbook(sqlite_db, month, None, "qa@example.com")))
    assert wb.sheetnames == ["Summary", "Tenants", "Discount lines", "Measurements", "Trend"]
    t = wb["Tenants"]
    head = [c.value for c in t[1]]
    for col in ("Total cost", "Original MRR", "Discount", "Net MRR", "Gross profit", "Gross margin %"):
        assert col in head
    alpha = next(row for row in t.iter_rows(min_row=2, values_only=True) if row[0] == "Alpha")
    get = dict(zip(head, alpha))
    assert get["Original MRR"] == 20000 and get["Discount"] == 2000 and get["Net MRR"] == 18000 and get["Gross profit"] == -8310
    total = [row for row in t.iter_rows(min_row=2, values_only=True)][-1]
    assert total[0] == "Total" and dict(zip(head, total))["Net MRR"] == 23000
    assert wb["Discount lines"].max_row == 2


def test_server_pools_split_rules(monkeypatch):
    from app.services import platform_infrastructure as infra
    monkeypatch.setattr(infra, "server_inventory", lambda: [
        {"name": "app", "monthly_cost": 30000},
        {"name": "db", "db_host": "10.0.0.2", "monthly_cost": 20000},
        {"name": "combo", "db_host": "localhost", "local": True, "monthly_cost": 10000},
        {"name": "split", "monthly_cost": 10000, "cost_split": {"compute": 3, "storage": 1, "egress": 1, "bogus": 5}},
        {"name": "free"},
    ])
    sp = fo.server_pools()
    assert sp["pools"] == {"compute": D("41000.00"), "database": D("25000.00"), "storage": D("2000.00"), "ai": D("0"), "egress": D("2000.00")}
    assert sp["unpriced"] == ["free"]
    assert {s["name"]: s["rule"] for s in sp["servers"]}["combo"] == "API + databases: half each"
