"""KPI drill-down engine shared by every platform module.

Each KPI card on a platform page has a registered ``Kpi`` spec keyed ``"<page>.<kpi>"``. A spec reads its records either
from SQL (``sql``: a SELECT over the master database, wrapped as a derived table so filters, sorting and paging run in
MariaDB) or from Python (``rows``: a function that returns dicts, for figures that live outside the database such as
request histograms or server probes). The engine applies the same search / status / tenant / date / facet filters to
both, enforces the caller's tenant scope, and returns one payload: columns, summary figures, a breakdown, filter options
and one page of rows.
"""

from __future__ import annotations

import csv
import io
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Callable, Optional, Union

from sqlalchemy import bindparam, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

MAX_PAGE_SIZE = 100
MAX_EXPORT_ROWS = 10_000
_KINDS = {"text", "num", "inr", "pct", "date", "datetime", "pill", "mb", "bytes", "ms", "bool", "code"}


@dataclass
class Col:
    key: str
    label: str
    kind: str = "text"  # text | num | inr | pct | date | datetime | pill | mb | bytes | ms | bool | code
    hidden: bool = False  # kept for the record detail view only

    def __post_init__(self) -> None:
        assert self.kind in _KINDS, self.kind


Summary = tuple[str, Union[str, Callable[[list[dict]], Any]], str]  # (label, SQL aggregate over q.* or fn(rows), kind)


@dataclass
class Kpi:
    key: str
    title: str
    module: Union[str, tuple[str, ...]]  # platform_access module key(s) whose "view" level the caller needs
    columns: list[Col]
    sql: Optional[str] = None
    rows: Optional[Callable[[Session, dict], list[dict]]] = None
    params: Callable[[], dict] = field(default=lambda: {})
    search: tuple[str, ...] = ()
    status: Optional[str] = None  # column offered as the Status filter
    date: Optional[str] = None  # column the date range applies to
    tenant: Optional[str] = "tenant_id"  # tenant id column (scope + tenant filter); None when records aren't per tenant
    tenant_name: Optional[str] = "tenant"
    sort: Optional[str] = None
    desc: bool = True
    summary: list[Summary] = field(default_factory=list)
    group: Optional[str] = None  # breakdown column (chart); clicking a bar filters on it
    amount: Optional[str] = None  # summed per breakdown group when set
    link: Optional[str] = None  # record route, e.g. "/platform/tenants/{tenant_id}"
    note: Optional[str] = None
    description: Optional[str] = None

    @property
    def keys(self) -> set[str]:
        return {c.key for c in self.columns}


REGISTRY: dict[str, Kpi] = {}


def register(*kpis: Kpi) -> None:
    for kpi in kpis:
        assert kpi.key not in REGISTRY, f"duplicate KPI {kpi.key}"
        assert kpi.sql or kpi.rows, kpi.key
        for name in (kpi.status, kpi.date, kpi.sort, kpi.group, kpi.amount, *kpi.search):
            assert name is None or name in kpi.keys, f"{kpi.key}: unknown column {name}"
        REGISTRY[kpi.key] = kpi


def modules_of(kpi: Kpi) -> tuple[str, ...]:
    return (kpi.module,) if isinstance(kpi.module, str) else kpi.module


@dataclass
class Query:
    q: str = ""
    status: str = ""
    tenant_id: Optional[int] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    facet: Optional[str] = None  # value of the breakdown column
    sort: Optional[str] = None
    desc: Optional[bool] = None
    page: int = 1
    page_size: int = 25
    scope: Optional[set[int]] = None  # tenant ids the caller may see; None = all


# ── value helpers ─────────────────────────────────────────────────────────────

def _json(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.isoformat() + ("Z" if value.tzinfo is None else "")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


def _clean(row: dict) -> dict:
    return {k: _json(v) for k, v in row.items()}


def _as_date(value: Any) -> Optional[date]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "")).date()
    except ValueError:
        return None


# ── SQL source ────────────────────────────────────────────────────────────────

def _sql_where(kpi: Kpi, query: Query, params: dict, *, with_facet: bool = True, with_status: bool = True) -> str:
    where = ["1=1"]
    if query.q and kpi.search:
        params["_q"] = f"%{query.q.strip()}%"
        where.append("(" + " OR ".join(f"CAST(q.`{c}` AS CHAR) LIKE :_q" for c in kpi.search) + ")")
    if with_status and query.status and kpi.status:
        params["_status"] = query.status
        where.append(f"q.`{kpi.status}` = :_status")
    if kpi.tenant:
        if query.tenant_id is not None:
            params["_tid"] = query.tenant_id
            where.append(f"q.`{kpi.tenant}` = :_tid")
        if query.scope is not None:
            params["_scope"] = sorted(query.scope) or [-1]
            where.append(f"q.`{kpi.tenant}` IN :_scope")
    if kpi.date:
        if query.date_from:
            params["_df"] = query.date_from
            where.append(f"q.`{kpi.date}` >= :_df")
        if query.date_to:
            params["_dt"] = query.date_to + timedelta(days=1)
            where.append(f"q.`{kpi.date}` < :_dt")
    if with_facet and kpi.group and query.facet is not None:
        if query.facet == "":
            where.append(f"q.`{kpi.group}` IS NULL")
        else:
            params["_facet"] = query.facet
            where.append(f"CAST(q.`{kpi.group}` AS CHAR) = :_facet")
    return " AND ".join(where)


def _exec(db: Session, sql: str, params: dict):
    stmt = text(sql)
    if "_scope" in params:
        stmt = stmt.bindparams(bindparam("_scope", expanding=True))
    return db.execute(stmt, params)


def _sql_run(db: Session, kpi: Kpi, query: Query, export: bool) -> dict:
    base = f"({kpi.sql}) q"
    params = dict(kpi.params())
    where = _sql_where(kpi, query, params)
    sort = query.sort if query.sort in kpi.keys else kpi.sort
    desc = kpi.desc if query.desc is None else query.desc
    order = f" ORDER BY q.`{sort}` {'DESC' if desc else 'ASC'}" if sort else ""
    total = _exec(db, f"SELECT COUNT(*) FROM {base} WHERE {where}", params).scalar() or 0
    limit = MAX_EXPORT_ROWS if export else query.page_size
    offset = 0 if export else (query.page - 1) * query.page_size
    rows = [_clean(dict(r._mapping)) for r in _exec(db, f"SELECT * FROM {base} WHERE {where}{order} LIMIT {int(limit)} OFFSET {int(offset)}", params)]
    if export:
        return {"rows": rows, "total": total}

    summary = []
    sql_aggs = [(i, s) for i, s in enumerate(kpi.summary) if isinstance(s[1], str)]
    if sql_aggs:
        agg = _exec(db, f"SELECT {', '.join(f'{expr} AS s{i}' for i, (_, expr, _) in sql_aggs)} FROM {base} WHERE {where}", params).first()
        values = dict(agg._mapping) if agg else {}
        summary = [{"label": label, "value": _json(values.get(f"s{i}")), "kind": kind} for i, (label, _, kind) in sql_aggs]

    breakdown = []
    if kpi.group:
        bparams = dict(kpi.params())
        bwhere = _sql_where(kpi, query, bparams, with_facet=False)
        amount = f", SUM(q.`{kpi.amount}`) AS v" if kpi.amount else ""
        for r in _exec(db, f"SELECT q.`{kpi.group}` AS k, COUNT(*) AS n{amount} FROM {base} WHERE {bwhere} GROUP BY q.`{kpi.group}` ORDER BY n DESC LIMIT 12", bparams):
            m = r._mapping
            breakdown.append({"key": "" if m["k"] is None else str(_json(m["k"])), "count": int(m["n"]), "amount": _json(m.get("v")) if kpi.amount else None})

    statuses = []
    if kpi.status:
        sparams = dict(kpi.params())
        swhere = _sql_where(kpi, Query(scope=query.scope), sparams)
        statuses = [str(_json(r[0])) for r in _exec(db, f"SELECT DISTINCT q.`{kpi.status}` FROM {base} WHERE {swhere} AND q.`{kpi.status}` IS NOT NULL ORDER BY 1 LIMIT 40", sparams)]

    tenants = []
    if kpi.tenant and kpi.tenant_name and kpi.tenant_name in kpi.keys:
        tparams = dict(kpi.params())
        twhere = _sql_where(kpi, Query(scope=query.scope), tparams)
        tenants = [{"id": r[0], "name": r[1]} for r in _exec(
            db, f"SELECT DISTINCT q.`{kpi.tenant}`, q.`{kpi.tenant_name}` FROM {base} WHERE {twhere} AND q.`{kpi.tenant}` IS NOT NULL ORDER BY 2 LIMIT 300", tparams)]
    return {"rows": rows, "total": total, "summary": summary, "breakdown": breakdown, "statuses": statuses, "tenants": tenants}


# ── Python source ─────────────────────────────────────────────────────────────

def _py_filter(kpi: Kpi, rows: list[dict], query: Query, *, with_facet: bool = True, with_status: bool = True) -> list[dict]:
    out = rows
    if query.q and kpi.search:
        needle = query.q.strip().lower()
        out = [r for r in out if any(needle in str(r.get(c) or "").lower() for c in kpi.search)]
    if with_status and query.status and kpi.status:
        out = [r for r in out if str(r.get(kpi.status)) == query.status]
    if kpi.tenant:
        if query.tenant_id is not None:
            out = [r for r in out if r.get(kpi.tenant) == query.tenant_id]
        if query.scope is not None:
            out = [r for r in out if r.get(kpi.tenant) in query.scope]
    if kpi.date and (query.date_from or query.date_to):
        def inside(r: dict) -> bool:
            d = _as_date(r.get(kpi.date))
            return d is not None and (not query.date_from or d >= query.date_from) and (not query.date_to or d <= query.date_to)
        out = [r for r in out if inside(r)]
    if with_facet and kpi.group and query.facet is not None:
        out = [r for r in out if ("" if r.get(kpi.group) is None else str(_json(r.get(kpi.group)))) == query.facet]
    return out


def _py_run(db: Session, kpi: Kpi, query: Query, export: bool) -> dict:
    source = [_clean(r) for r in kpi.rows(db, {"scope": query.scope, "tenant_id": query.tenant_id if kpi.tenant else None})]
    rows = _py_filter(kpi, source, query)
    sort = query.sort if query.sort in kpi.keys else kpi.sort
    desc = kpi.desc if query.desc is None else query.desc
    if sort:
        present = [r for r in rows if r.get(sort) is not None]
        missing = [r for r in rows if r.get(sort) is None]
        try:
            present.sort(key=lambda r: r[sort], reverse=desc)
        except TypeError:
            present.sort(key=lambda r: str(r[sort]), reverse=desc)
        rows = present + missing
    total = len(rows)
    if export:
        return {"rows": rows[:MAX_EXPORT_ROWS], "total": total}
    page = rows[(query.page - 1) * query.page_size: query.page * query.page_size]
    summary = [{"label": label, "value": _json(fn(rows)), "kind": kind} for label, fn, kind in kpi.summary if callable(fn)]
    breakdown = []
    if kpi.group:
        counts: dict[str, list] = {}
        for r in _py_filter(kpi, source, query, with_facet=False):
            k = "" if r.get(kpi.group) is None else str(r.get(kpi.group))
            entry = counts.setdefault(k, [0, 0.0])
            entry[0] += 1
            if kpi.amount:
                entry[1] += float(r.get(kpi.amount) or 0)
        breakdown = [{"key": k, "count": n, "amount": round(v, 2) if kpi.amount else None} for k, (n, v) in sorted(counts.items(), key=lambda kv: -kv[1][0])[:12]]
    scoped = _py_filter(kpi, source, Query(scope=query.scope))
    statuses = sorted({str(r[kpi.status]) for r in scoped if r.get(kpi.status) is not None}) if kpi.status else []
    tenants = []
    if kpi.tenant and kpi.tenant_name:
        seen = {r[kpi.tenant]: r.get(kpi.tenant_name) for r in scoped if r.get(kpi.tenant) is not None}
        tenants = sorted(({"id": k, "name": v or f"#{k}"} for k, v in seen.items()), key=lambda t: str(t["name"]).lower())
    return {"rows": page, "total": total, "summary": summary, "breakdown": breakdown, "statuses": statuses, "tenants": tenants}


# ── entry points ──────────────────────────────────────────────────────────────

def _missing_table(exc: Exception) -> bool:
    msg = str(getattr(exc, "orig", exc))
    return "1146" in msg or "doesn't exist" in msg or "1054" in msg


def run(db: Session, kpi: Kpi, query: Query) -> dict:
    query.page = max(1, query.page)
    query.page_size = max(1, min(MAX_PAGE_SIZE, query.page_size))
    note = kpi.note
    try:
        result = _sql_run(db, kpi, query, False) if kpi.sql else _py_run(db, kpi, query, False)
    except DBAPIError as exc:
        db.rollback()
        if not _missing_table(exc):
            raise
        logger.info("KPI %s source not available yet: %s", kpi.key, exc)
        result = {"rows": [], "total": 0, "summary": [], "breakdown": [], "statuses": [], "tenants": []}
        note = "No records yet — this module has not stored any data."
    return {
        "key": kpi.key, "title": kpi.title, "description": kpi.description, "note": note,
        "columns": [{"key": c.key, "label": c.label, "kind": c.kind, "hidden": c.hidden} for c in kpi.columns],
        "search": bool(kpi.search), "status_filter": kpi.status is not None, "date_filter": kpi.date is not None,
        "tenant_filter": kpi.tenant is not None and kpi.tenant_name is not None,
        "group": kpi.group, "group_label": next((c.label for c in kpi.columns if c.key == kpi.group), None),
        "group_kind": next((c.kind for c in kpi.columns if c.key == kpi.group), None),
        "amount_label": next((c.label for c in kpi.columns if c.key == kpi.amount), None),
        "amount_kind": next((c.kind for c in kpi.columns if c.key == kpi.amount), None),
        "sort": query.sort if query.sort in kpi.keys else kpi.sort, "desc": kpi.desc if query.desc is None else query.desc,
        "link": kpi.link, "page": query.page, "page_size": query.page_size, **result,
    }


def export_csv(db: Session, kpi: Kpi, query: Query) -> tuple[str, int]:
    result = _sql_run(db, kpi, query, True) if kpi.sql else _py_run(db, kpi, query, True)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([c.label for c in kpi.columns])
    for row in result["rows"]:
        writer.writerow(["" if row.get(c.key) is None else row.get(c.key) for c in kpi.columns])
    return buf.getvalue(), len(result["rows"])
