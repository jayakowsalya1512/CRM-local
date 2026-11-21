"""Tenant schema integrity – every integer ``id`` column is the PRIMARY KEY with AUTO_INCREMENT.

Why: tables created through SQLAlchemy already get ``id INT NOT NULL AUTO_INCREMENT PRIMARY KEY``, but a tenant database
that was imported from a dump, restored or copied by hand can lose both. MariaDB then accepts inserts without an id and
stores ``id = 0`` for every new row, so records collide and links (/approvals/0 …) break.

What ``repair_engine`` does for each base table whose ``id`` column is an integer without AUTO_INCREMENT:
  1. skips it when it cannot be fixed safely – non-zero ids are duplicated, or another table still points at a row with
     id 0 (those cases are reported, never guessed). Tables whose primary key is on other / more columns are a deliberate
     design and are not touched;
  2. gives every ``id = 0`` row a new id after the current maximum, in creation order (created_at when the table has it);
  3. ``ALTER TABLE … MODIFY id <type> NOT NULL AUTO_INCREMENT`` (+ ``ADD PRIMARY KEY (id)`` when the table has none).
Backup / copy tables (``*_bak*``, ``*_backup*``, ``*_old``, ``*_copy``) are left alone. A MariaDB named lock keeps two
workers from altering the same database at once. Every change is logged.

It runs: when a tenant is created (after its tables are built), after a backup is restored into a new database, from
Platform → Tenant → Maintenance → Schema sync, for every tenant at application start-up, and hourly as a platform job
(catches databases imported manually while the application is running).
"""
from __future__ import annotations

import logging
import re
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

SKIP_NAME = re.compile(r"(_bak|_backup|_old$|_copy$)", re.I)


def _q(name: str) -> str:
    return "`" + name.replace("`", "``") + "`"


def candidates(conn) -> list[dict[str, Any]]:
    """Integer ``id`` columns without AUTO_INCREMENT in the connection's current database (read-only)."""
    rows = conn.execute(text(
        "SELECT c.table_name, c.column_type, "
        "(SELECT GROUP_CONCAT(k.column_name ORDER BY k.ordinal_position) FROM information_schema.key_column_usage k "
        "  WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.constraint_name = 'PRIMARY') AS pk, "
        "(SELECT COUNT(*) FROM information_schema.columns x WHERE x.table_schema = c.table_schema AND x.table_name = c.table_name "
        "  AND x.column_name = 'created_at') AS has_created "
        "FROM information_schema.columns c JOIN information_schema.tables t "
        "  ON t.table_schema = c.table_schema AND t.table_name = c.table_name "
        "WHERE c.table_schema = DATABASE() AND c.column_name = 'id' AND t.table_type = 'BASE TABLE' "
        "  AND c.data_type IN ('tinyint', 'smallint', 'mediumint', 'int', 'bigint') AND c.extra NOT LIKE '%auto_increment%'"
    )).all()
    out = [{"table": r[0], "type": r[1], "pk": (r[2] or "").split(",") if r[2] else [], "has_created": bool(r[3])}
           for r in rows if not SKIP_NAME.search(r[0])]
    # a primary key on other / more columns is a deliberate design (composite keys …) – not applicable, not a defect
    return [c for c in out if c["pk"] in ([], ["id"])]


def _children_pointing_at_zero(conn, table: str) -> list[str]:
    refs = conn.execute(text("SELECT table_name, column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() "
                             "AND referenced_table_name = :t AND referenced_column_name = 'id'"), {"t": table}).all()
    out = []
    for child, col in refs:
        if conn.execute(text(f"SELECT 1 FROM {_q(child)} WHERE {_q(col)} = 0 LIMIT 1")).first():
            out.append(f"{child}.{col}")
    return out


def _fix_table(conn, c: dict[str, Any]) -> dict[str, Any]:
    t, qt = c["table"], _q(c["table"])
    dup = conn.execute(text(f"SELECT COUNT(*) FROM (SELECT id FROM {qt} WHERE id <> 0 GROUP BY id HAVING COUNT(*) > 1) d")).scalar()
    if dup:
        return {"table": t, "status": "skipped", "reason": f"{dup} non-zero id value(s) are duplicated – needs a manual decision"}
    zeros = int(conn.execute(text(f"SELECT COUNT(*) FROM {qt} WHERE id = 0")).scalar() or 0)
    if zeros:
        kids = _children_pointing_at_zero(conn, t)
        if kids:
            return {"table": t, "status": "skipped", "reason": f"{', '.join(kids)} still point at id 0 – cannot tell which row they belong to"}
        start = int(conn.execute(text(f"SELECT COALESCE(MAX(id), 0) FROM {qt}")).scalar() or 0)
        conn.execute(text("SET @ai_n := :n"), {"n": start})
        order = " ORDER BY created_at" if c["has_created"] else ""
        conn.execute(text(f"UPDATE {qt} SET id = (@ai_n := @ai_n + 1) WHERE id = 0{order}"))
        conn.commit()
    ddl = f"ALTER TABLE {qt} MODIFY {_q('id')} {c['type']} NOT NULL AUTO_INCREMENT" + ("" if c["pk"] else f", ADD PRIMARY KEY ({_q('id')})")
    conn.execute(text(ddl))
    conn.commit()
    nxt = conn.execute(text("SELECT AUTO_INCREMENT FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = :t"), {"t": t}).scalar()
    return {"table": t, "status": "fixed", "renumbered": zeros, "added_primary_key": not c["pk"], "next_id": nxt}


def repair_engine(engine: Engine, label: str = "") -> dict[str, Any]:
    """Repair one database (see module docstring). Safe to call repeatedly – a healthy database costs one read query."""
    report: dict[str, Any] = {"database": label, "fixed": [], "skipped": [], "errors": []}
    with engine.connect() as conn:
        todo = candidates(conn)
        if not todo:
            return report
        db_name = conn.execute(text("SELECT DATABASE()")).scalar()
        if not conn.execute(text("SELECT GET_LOCK(:k, 0)"), {"k": f"ai_repair:{db_name}"[:64]}).scalar():
            report["errors"].append("another worker is repairing this database")
            return report
        try:
            for c in todo:
                try:
                    r = _fix_table(conn, c)
                except Exception as exc:
                    conn.rollback()
                    report["errors"].append(f"{c['table']}: {exc}")
                    logger.error("AUTO_INCREMENT repair %s.%s failed: %s", label or db_name, c["table"], exc)
                    continue
                (report["fixed"] if r["status"] == "fixed" else report["skipped"]).append(r)
                if r["status"] == "fixed":
                    logger.warning("AUTO_INCREMENT repaired on %s.%s (renumbered %s id=0 row(s), primary key added: %s, next id %s)",
                                   label or db_name, r["table"], r["renumbered"], r["added_primary_key"], r["next_id"])
                else:
                    logger.error("AUTO_INCREMENT not repaired on %s.%s: %s", label or db_name, r["table"], r["reason"])
        finally:
            conn.execute(text("SELECT RELEASE_LOCK(:k)"), {"k": f"ai_repair:{db_name}"[:64]})
    return report


def repair_db_name(db_name: str) -> dict[str, Any]:
    from app.database import get_tenant_engine_by_db_name
    return repair_engine(get_tenant_engine_by_db_name(db_name), db_name)


def repair_tenant(slug: str) -> dict[str, Any]:
    from app.database import get_tenant_engine
    return repair_engine(get_tenant_engine(slug), slug)


def repair_all_tenants() -> dict[str, Any]:
    """Every tenant database; returns only the tenants where something was fixed, skipped or failed."""
    from app.database import MasterSessionLocal
    from app.models.tenant import Tenant
    m = MasterSessionLocal()
    try:
        slugs = [t.slug for t in m.query(Tenant).all()]
    finally:
        m.close()
    out: dict[str, Any] = {}
    for slug in slugs:
        try:
            r = repair_tenant(slug)
        except Exception as exc:
            logger.warning("AUTO_INCREMENT check for tenant %s failed: %s", slug, exc)
            out[slug] = {"errors": [str(exc)]}
            continue
        if r["fixed"] or r["skipped"] or r["errors"]:
            out[slug] = {"fixed": [x["table"] for x in r["fixed"]], "skipped": [f"{x['table']}: {x['reason']}" for x in r["skipped"]], "errors": r["errors"]}
    return out


def summary(r: dict[str, Any]) -> str:
    parts = []
    if r.get("fixed"):
        parts.append(f"AUTO_INCREMENT restored on {len(r['fixed'])} table(s)")
    if r.get("skipped"):
        parts.append(f"{len(r['skipped'])} table(s) need manual review")
    return " · ".join(parts)
