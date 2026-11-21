"""Governance & ecosystem KPIs: Security & compliance, Trust & safety, SLA & CSAT, API & webhooks, Rate limits & API keys,
Mobile app control and Marketplace. Conditions mirror the routers / services that compute each card, so totals match.
Secrets never leave the database: API-key hashes, publisher key hashes and webhook secrets are not selected."""

from __future__ import annotations

import time
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.platform_kpi import Col, Kpi, register
from app.services.platform_kpi_specs.common import TENANT_LINK, count_where, tenants_where
from app.services.platform_kpi_specs.core import TENANT_BREAKDOWN, _tenants

# ── Security & compliance ────────────────────────────────────────────────────

def _controls(categories: tuple[str, ...] | None = None):
    def rows(db: Session, ctx: dict) -> list[dict]:
        from app.routers.platform_security_router import ENFORCED, POSTURE_CATEGORIES
        from app.services import platform_controls as controls

        values = controls.platform_values(db)
        out = []
        for cat in controls.schema(db):
            if cat["name"] not in (categories or POSTURE_CATEGORIES):
                continue
            for g in cat["groups"]:
                for c in g["controls"]:
                    v = values.get(c["key"])
                    on = c["status"] in ENFORCED and (c["type"] != "sw" or v is True)
                    out.append({"key": c["key"], "label": c["label"], "category": cat["name"], "group": g["name"], "status": c["status"], "type": c["type"],
                                "value": v if not isinstance(v, (list, dict)) else str(v), "default": str(c.get("default")), "in_force": "In force" if on else "Not in force",
                                "note": c.get("note")})
        return out
    return rows


CONTROL_COLS = [Col("label", "Control"), Col("category", "Category"), Col("status", "Status", "pill"), Col("value", "Value"), Col("in_force", "Posture", "pill"),
                Col("group", "Group", hidden=True), Col("key", "Key", "code", hidden=True), Col("type", "Type", hidden=True), Col("default", "Default", hidden=True),
                Col("note", "Note", hidden=True)]
CONTROLS = dict(columns=CONTROL_COLS, tenant=None, tenant_name=None, search=("label", "key", "category", "group"), status="status", sort="category", desc=False,
                link="/platform/control-center")


def _key_rotation(db: Session, ctx: dict) -> list[dict]:
    """Encryption key per tenant database when data-at-rest encryption is on; otherwise every tenant database, unencrypted."""
    from app.routers.platform_security_router import _encryption

    enc = _encryption(db)
    keys: dict[str, tuple] = {}
    if enc["available"]:
        keys = {r[0]: (r[1], r[2], r[3]) for r in db.execute(text(
            "SELECT SUBSTRING_INDEX(NAME, '/', 1), MAX(CURRENT_KEY_ID), MAX(CURRENT_KEY_VERSION), COUNT(*) FROM information_schema.INNODB_TABLESPACES_ENCRYPTION "
            "WHERE NAME LIKE 'digitcrm\\_%' GROUP BY SUBSTRING_INDEX(NAME, '/', 1)")).all()}
    out = []
    for t in _tenants(db, ctx):
        k = keys.get(t.db_name)
        out.append({"tenant_id": t.id, "tenant": t.name, "db_name": t.db_name, "encryption": "Encrypted" if k else "Not encrypted",
                    "key_id": k[0] if k else None, "key_version": k[1] if k else None, "tablespaces": k[2] if k else None,
                    "rotated": None, "next_rotation": None, "plugin": enc.get("plugin")})
    return out


register(
    Kpi("security.compliance", "Compliance controls", "settings", rows=_controls(), group="in_force", **CONTROLS,
        description="Control Center security, identity and privacy controls; in force = enforced by the platform (live / fixed) and switched on",
        summary=[("In force", lambda rows: sum(1 for r in rows if r["in_force"] == "In force"), "num"), ("Controls", lambda rows: len(rows), "num"),
                 ("Posture", lambda rows: round(100 * sum(1 for r in rows if r["in_force"] == "In force") / len(rows)) if rows else None, "pct")]),
    Kpi("security.dsar", "Open DSARs", "settings", rows=_controls(("Privacy & data requests",)), group="status", **CONTROLS,
        note="Data-subject requests are not handled on this platform yet (no request store), so the value is “—”. Listed: the privacy & data-request controls."),
    Kpi("security.vulnerabilities", "Critical vulnerabilities", "settings", rows=_controls(("Security & threat protection",)), group="status", **CONTROLS,
        note="No vulnerability scanner is connected, so the value is “—”. Listed: the security & threat-protection controls."),
    Kpi("security.key_rotations", "Key rotations due", "settings", rows=_key_rotation, group="encryption", sort="tenant", desc=False, link=TENANT_LINK,
        columns=[Col("tenant", "Tenant"), Col("db_name", "Database", "code"), Col("encryption", "At rest", "pill"), Col("key_id", "Key ID", "num"),
                 Col("key_version", "Key version", "num"), Col("rotated", "Rotated", "date"), Col("next_rotation", "Next rotation", "date"),
                 Col("tablespaces", "Encrypted tablespaces", "num", hidden=True), Col("plugin", "Key plugin", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)],
        search=("tenant", "db_name"), status="encryption",
        note="MariaDB records no key rotation dates, so no rotation can be shown as due (“—”). Listed: each tenant database and its data-at-rest encryption key."),
)


# ── Trust & safety ───────────────────────────────────────────────────────────

CASES_SQL = """
SELECT c.id, c.ref, c.title, c.category, c.severity, c.status, c.tenant_id, COALESCE(c.tenant_name, t.name) AS tenant, c.source, c.assigned_to, c.opened_by,
       c.opened_at, c.closed_at, c.legal_hold, (SELECT COUNT(*) FROM platform_case_evidence e WHERE e.case_id = c.id) AS evidence,
       ROUND(TIMESTAMPDIFF(SECOND, c.opened_at, COALESCE(c.closed_at, UTC_TIMESTAMP())) / 86400, 1) AS age_days
FROM platform_abuse_cases c LEFT JOIN tenants t ON t.id = c.tenant_id
"""
CASE_COLS = [Col("ref", "Case", "code"), Col("title", "Summary"), Col("category", "Category"), Col("severity", "Severity", "pill"), Col("status", "Status", "pill"),
             Col("tenant", "Tenant"), Col("opened_at", "Opened", "datetime"), Col("age_days", "Age (days)", "num"), Col("evidence", "Evidence", "num"),
             Col("source", "Source", hidden=True), Col("assigned_to", "Assigned", hidden=True), Col("opened_by", "Opened by", hidden=True),
             Col("closed_at", "Closed", "datetime", hidden=True), Col("legal_hold", "Legal hold", "bool", hidden=True),
             Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Case ID", "num", hidden=True)]
CASES = dict(columns=CASE_COLS, search=("ref", "title", "tenant", "source", "category"), status="status", date="opened_at", sort="opened_at",
             link="/platform/trust-safety?case={id}")
OPEN_CASES = "c.status IN ('Under review', 'Investigating', 'Escalated')"

ENFORCEMENT_SQL = """
SELECT a.id, a.created_at, a.action, a.target, a.reason, a.actor, a.tenant_id, t.name AS tenant, a.user_id, a.case_id, c.ref AS case_ref, a.notes
FROM platform_enforcement_actions a LEFT JOIN tenants t ON t.id = a.tenant_id LEFT JOIN platform_abuse_cases c ON c.id = a.case_id
"""


def _suspended_users(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_trust_safety as ts

    scope = None if ctx["scope"] is None else sorted(ctx["scope"])
    users = ts.all_users(db, scope, "", 0, 1_000_000)
    return [{**{k: u[k] for k in ("tenant_id", "tenant", "tenant_slug", "id", "name", "email", "role", "last_active", "status")}, "mfa": u["mfa"]}
            for u in users["items"] if u["status"] == "Suspended"]


register(
    Kpi("trust.open_cases", "Open cases", "tenants", sql=f"SELECT * FROM ({CASES_SQL}) cc WHERE cc.status IN ('Under review', 'Investigating', 'Escalated')",
        group="severity", **CASES, summary=[("Critical", count_where("q.severity = 'Critical'"), "num"), ("Escalated", count_where("q.status = 'Escalated'"), "num")]),
    Kpi("trust.critical", "Critical", "tenants", sql=f"SELECT * FROM ({CASES_SQL}) cc WHERE cc.status IN ('Under review', 'Investigating', 'Escalated') AND cc.severity = 'Critical'",
        group="category", **CASES),
    Kpi("trust.users_terminated", "Users terminated · 90d", "tenants",
        sql=f"SELECT * FROM ({ENFORCEMENT_SQL}) ea WHERE ea.action = 'User terminated' AND ea.created_at >= UTC_TIMESTAMP() - INTERVAL 90 DAY",
        columns=[Col("created_at", "When", "datetime"), Col("target", "User"), Col("tenant", "Tenant"), Col("reason", "Reason"), Col("case_ref", "Case", "code"),
                 Col("actor", "By"), Col("notes", "Notes", hidden=True), Col("action", "Action", hidden=True), Col("user_id", "User ID", "num", hidden=True),
                 Col("case_id", "Case ID", "num", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Action ID", "num", hidden=True)],
        search=("target", "tenant", "reason", "actor"), date="created_at", sort="created_at", group="reason", link=TENANT_LINK),
    Kpi("trust.users_suspended", "Users suspended", "tenants", rows=_suspended_users, sort="last_active", group="tenant", link=TENANT_LINK,
        columns=[Col("name", "User"), Col("email", "E-mail"), Col("tenant", "Tenant"), Col("role", "Role"), Col("last_active", "Last active", "datetime"),
                 Col("status", "Status", "pill"), Col("mfa", "MFA", "bool", hidden=True), Col("tenant_slug", "Tenant slug", "code", hidden=True),
                 Col("id", "User ID", "num", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)],
        search=("name", "email", "tenant", "role"), date="last_active",
        description="Tenant users whose account is deactivated (is_active = 0) without a Trust & Safety termination block"),
    Kpi("trust.tenants_suspended", "Tenants suspended", "tenants", sql=tenants_where("tt.status = 'suspended'"), group="plan", **TENANT_BREAKDOWN),
    Kpi("trust.avg_resolution", "Avg. resolution", "tenants", sql=f"SELECT * FROM ({CASES_SQL}) cc WHERE cc.status = 'Closed' AND cc.closed_at IS NOT NULL",
        group="category", **{**CASES, "sort": "closed_at", "date": "closed_at", "columns": [
            Col("ref", "Case", "code"), Col("title", "Summary"), Col("category", "Category"), Col("severity", "Severity", "pill"), Col("tenant", "Tenant"),
            Col("opened_at", "Opened", "datetime"), Col("closed_at", "Closed", "datetime"), Col("age_days", "Resolution (days)", "num"),
            *[c for c in CASE_COLS if c.hidden and c.key != "closed_at"], Col("status", "Status", "pill", hidden=True)]},
        summary=[("Avg. resolution (days)", "ROUND(AVG(q.age_days), 1)", "num"), ("Longest (days)", "MAX(q.age_days)", "num")]),
)


# ── SLA & customer satisfaction ──────────────────────────────────────────────

_FIRST_B = "(s.first_breached = 1 OR (s.first_response_at IS NULL AND s.first_response_due < UTC_TIMESTAMP()))"
_RES_B = "(s.resolution_breached = 1 OR (s.resolved_at IS NULL AND s.resolution_due < UTC_TIMESTAMP()))"
SLA_SQL = f"""
SELECT s.ticket_id, tk.ref, tk.subject, tk.requester_name, tk.requester_email, tk.priority, tk.status AS ticket_status, s.tenant_id, t.name AS tenant, p.name AS plan,
       CASE s.priority_code WHEN 'P1' THEN 'P1 – Critical' WHEN 'P2' THEN 'P2 – High' ELSE 'P3 – Normal' END AS priority_label, s.coverage, s.created_at,
       s.first_response_due, s.first_response_at, ROUND(s.first_response_secs / 3600, 1) AS first_response_h, s.resolution_due, s.resolved_at,
       ROUND(s.resolution_secs / 3600, 1) AS resolution_h, CASE WHEN {_FIRST_B} THEN 'Breached' ELSE 'OK' END AS first_response,
       CASE WHEN {_RES_B} THEN 'Breached' ELSE 'OK' END AS resolution,
       CASE WHEN {_FIRST_B} OR {_RES_B} THEN 'Breached' WHEN s.first_breached = 0 AND s.resolution_breached = 0 THEN 'Met' ELSE 'In progress' END AS outcome
FROM platform_ticket_slas s JOIN platform_support_tickets tk ON tk.id = s.ticket_id JOIN tenants t ON t.id = s.tenant_id LEFT JOIN plans p ON p.id = s.plan_id
WHERE s.created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY
"""
SLA_COLS = [Col("ref", "Ticket", "code"), Col("tenant", "Tenant"), Col("subject", "Subject"), Col("priority_label", "Priority"), Col("created_at", "Opened", "datetime"),
            Col("first_response_h", "First response (h)", "num"), Col("resolution_h", "Resolution (h)", "num"), Col("outcome", "SLA", "pill"),
            Col("first_response", "First-response target", "pill", hidden=True), Col("resolution", "Resolution target", "pill", hidden=True),
            Col("first_response_due", "First response due", "datetime", hidden=True), Col("first_response_at", "First response at", "datetime", hidden=True),
            Col("resolution_due", "Resolution due", "datetime", hidden=True), Col("resolved_at", "Resolved at", "datetime", hidden=True),
            Col("priority", "Ticket priority", hidden=True), Col("ticket_status", "Ticket status", "pill", hidden=True), Col("plan", "Plan", hidden=True),
            Col("coverage", "Coverage", hidden=True), Col("requester_name", "Requester", hidden=True), Col("requester_email", "Requester e-mail", hidden=True),
            Col("tenant_id", "Tenant ID", "num", hidden=True), Col("ticket_id", "Ticket ID", "num", hidden=True)]
SLA = dict(columns=SLA_COLS, search=("ref", "tenant", "subject", "requester_email"), status="outcome", date="created_at", sort="created_at",
           link="/platform/support?ticket={ticket_id}")

CSAT_SQL = """
SELECT c.id, c.ticket_id, tk.ref, tk.subject, c.tenant_id, t.name AS tenant, c.rating, c.feedback, c.submitted_by, c.channel, c.submitted_at, tk.priority
FROM platform_ticket_csat c JOIN platform_support_tickets tk ON tk.id = c.ticket_id JOIN tenants t ON t.id = c.tenant_id
WHERE c.submitted_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY
"""

register(
    Kpi("sla.met", "SLA met · 30 days", "tenants", sql=SLA_SQL, group="outcome", **SLA,
        summary=[("Met", count_where("q.outcome = 'Met'"), "num"), ("Breached", count_where("q.outcome = 'Breached'"), "num"),
                 ("SLA met", "ROUND(100 * SUM(q.outcome = 'Met') / NULLIF(SUM(q.outcome IN ('Met', 'Breached')), 0), 1)", "pct")]),
    Kpi("sla.first_response", "Avg first response", "tenants", sql=f"SELECT * FROM ({SLA_SQL}) ss WHERE ss.first_response_h IS NOT NULL",
        group="priority_label", **{**SLA, "sort": "first_response_h"},
        summary=[("Avg first response (h)", "ROUND(AVG(q.first_response_h), 1)", "num"), ("Longest (h)", "MAX(q.first_response_h)", "num")]),
    Kpi("sla.resolution", "Avg resolution", "tenants", sql=f"SELECT * FROM ({SLA_SQL}) ss WHERE ss.resolution_h IS NOT NULL",
        group="priority_label", **{**SLA, "sort": "resolution_h"},
        summary=[("Avg resolution (h)", "ROUND(AVG(q.resolution_h), 1)", "num"), ("Longest (h)", "MAX(q.resolution_h)", "num")]),
    Kpi("sla.breaches", "Breaches", "tenants", sql=f"SELECT * FROM ({SLA_SQL}) ss WHERE ss.outcome = 'Breached'", group="priority_label", **SLA,
        summary=[("First-response breaches", count_where("q.first_response = 'Breached'"), "num"), ("Resolution breaches", count_where("q.resolution = 'Breached'"), "num")]),
    Kpi("sla.csat", "CSAT", "tenants", sql=CSAT_SQL, group="rating", link="/platform/support?ticket={ticket_id}",
        columns=[Col("submitted_at", "Rated", "datetime"), Col("ref", "Ticket", "code"), Col("tenant", "Tenant"), Col("rating", "Rating", "num"),
                 Col("feedback", "Feedback"), Col("submitted_by", "By"), Col("channel", "Channel", "pill"), Col("subject", "Subject", hidden=True),
                 Col("priority", "Priority", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True), Col("ticket_id", "Ticket ID", "num", hidden=True),
                 Col("id", "Rating ID", "num", hidden=True)],
        search=("ref", "tenant", "feedback", "submitted_by", "subject"), status="channel", date="submitted_at", sort="submitted_at",
        summary=[("Average", "ROUND(AVG(q.rating), 1)", "num"), ("Ratings", "COUNT(*)", "num"), ("4–5 ★", count_where("q.rating >= 4"), "num"),
                 ("1–2 ★", count_where("q.rating <= 2"), "num")]),
)


# ── API & webhooks / Rate limits & API keys ─────────────────────────────────

USAGE_SQL = """
SELECT t.id AS tenant_id, t.name AS tenant, t.slug, p.name AS plan, t.status,
       SUM(CASE WHEN u.meter = 'api' THEN u.value ELSE 0 END) AS requests, SUM(CASE WHEN u.meter = 'rate_limited' THEN u.value ELSE 0 END) AS rate_limited,
       ROUND(100 * SUM(CASE WHEN u.meter = 'rate_limited' THEN u.value ELSE 0 END) / NULLIF(SUM(CASE WHEN u.meter = 'api' THEN u.value ELSE 0 END), 0), 2) AS rate_limited_pct,
       rl.per_minute, rl.burst, rl.daily_cap,
       (SELECT COUNT(*) FROM platform_api_keys k WHERE k.tenant_id = t.id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > UTC_TIMESTAMP())) AS active_keys
FROM platform_tenant_usage_hours u JOIN tenants t ON t.slug = u.tenant_slug LEFT JOIN plans p ON p.id = t.plan_id LEFT JOIN platform_plan_rate_limits rl ON rl.plan_id = t.plan_id
WHERE u.hour >= FLOOR(UNIX_TIMESTAMP() / 3600) - 23 AND u.meter IN ('api', 'rate_limited')
GROUP BY t.id, t.name, t.slug, p.name, t.status, rl.per_minute, rl.burst, rl.daily_cap
"""
USAGE = dict(columns=[Col("tenant", "Tenant"), Col("plan", "Plan"), Col("requests", "API requests · 24 h", "num"), Col("rate_limited", "Throttled (429)", "num"),
                      Col("rate_limited_pct", "Throttled %", "pct"), Col("per_minute", "Limit / min", "num"), Col("active_keys", "Active keys", "num"),
                      Col("burst", "Burst", "num", hidden=True), Col("daily_cap", "Daily cap", "num", hidden=True), Col("slug", "Slug", "code", hidden=True),
                      Col("status", "Status", "pill", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)],
             search=("tenant", "slug", "plan"), status="status", group="plan", link=TENANT_LINK,
             description="Tenant API traffic metered per hour (current hour and the 23 before it)",
             summary=[("Requests", "SUM(q.requests)", "num"), ("Throttled", "SUM(q.rate_limited)", "num"),
                      ("Throttled %", "ROUND(100 * SUM(q.rate_limited) / NULLIF(SUM(q.requests), 0), 2)", "pct")])

DELIVERY_SQL = """
SELECT d.id, d.created_at, d.tenant_id, t.name AS tenant, d.event_type, d.endpoint_id,
       CASE d.status WHEN 'delivered' THEN 'Done' WHEN 'failed' THEN 'Failed' WHEN 'retrying' THEN 'Retrying' ELSE 'Pending' END AS status,
       d.attempts, d.response_code, d.latency_ms, d.last_error, d.next_attempt_at, d.finished_at, d.event_ref
FROM platform_webhook_deliveries d LEFT JOIN tenants t ON t.id = d.tenant_id
WHERE d.created_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR
"""
DELIVERIES = dict(columns=[Col("created_at", "Created", "datetime"), Col("tenant", "Tenant"), Col("event_type", "Event", "code"), Col("status", "Status", "pill"),
                           Col("attempts", "Attempts", "num"), Col("response_code", "HTTP", "num"), Col("latency_ms", "Latency", "ms"),
                           Col("last_error", "Last error", hidden=True), Col("next_attempt_at", "Next attempt", "datetime", hidden=True),
                           Col("finished_at", "Finished", "datetime", hidden=True), Col("endpoint_id", "Endpoint ID", "num", hidden=True),
                           Col("event_ref", "Event ref", "num", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Delivery ID", "num", hidden=True)],
                  search=("tenant", "event_type", "last_error"), status="status", date="created_at", sort="created_at", group="status", link=TENANT_LINK,
                  summary=[("Done", count_where("q.status = 'Done'"), "num"), ("Failed", count_where("q.status = 'Failed'"), "num"),
                           ("Avg latency", "ROUND(AVG(q.latency_ms))", "ms")])

KEYS_SQL = """
SELECT k.id, k.tenant_id, t.name AS tenant, k.name, CONCAT(k.prefix, '••••••••', COALESCE(k.last4, '••••')) AS key_masked, k.scopes, k.user_id,
       k.created_at, k.created_by, k.last_used_at, k.expires_at, k.revoked_at, k.revoked_by, k.replaced_by_id, DATEDIFF(UTC_TIMESTAMP(), k.created_at) AS age_days,
       CASE WHEN NOT (k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > UTC_TIMESTAMP())) THEN 'Revoked'
            WHEN k.expires_at IS NOT NULL OR k.created_at < UTC_TIMESTAMP() - INTERVAL 90 DAY THEN 'Rotate soon' ELSE 'Active' END AS status
FROM platform_api_keys k JOIN tenants t ON t.id = k.tenant_id
"""
USABLE = "kk.revoked_at IS NULL AND (kk.expires_at IS NULL OR kk.expires_at > UTC_TIMESTAMP())"
KEYS = dict(columns=[Col("tenant", "Tenant"), Col("name", "Key name"), Col("key_masked", "Key", "code"), Col("scopes", "Scopes"), Col("created_at", "Created", "date"),
                     Col("age_days", "Age (days)", "num"), Col("last_used_at", "Last used", "datetime"), Col("status", "Status", "pill"),
                     Col("created_by", "Created by", hidden=True), Col("user_id", "Signs in as user", "num", hidden=True), Col("expires_at", "Expires", "datetime", hidden=True),
                     Col("revoked_at", "Revoked", "datetime", hidden=True), Col("revoked_by", "Revoked by", hidden=True),
                     Col("replaced_by_id", "Replaced by key", "num", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Key ID", "num", hidden=True)],
            search=("tenant", "name", "key_masked", "created_by"), status="status", date="created_at", sort="created_at", group="tenant", link="/platform/rate-limits",
            description="API key metadata only – the key itself is shown once at creation and only its hash is stored")


def _traffic_24h(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_monitoring as monitor

    now = time.time()
    return [{"at": datetime.utcfromtimestamp(now - p["minutes_ago"] * 60), "minutes_ago": p["minutes_ago"], "requests": p["requests"], "rps": p["rps"],
             "p50": p["p50"], "p95": p["p95"], "p99": p["p99"], "error_rate": p["error_rate"],
             "errors": round((p["error_rate"] or 0) * p["requests"] / 100)} for p in monitor.series("api", "24h") if p["requests"]]


register(
    Kpi("webhooks.api_requests", "API requests · 24h", "tenants", sql=USAGE_SQL, sort="requests", **USAGE),
    Kpi("webhooks.deliveries", "Webhook deliveries", "tenants", sql=DELIVERY_SQL, **DELIVERIES),
    Kpi("webhooks.success", "Delivery success", "tenants", sql=f"SELECT * FROM ({DELIVERY_SQL}) dd WHERE dd.status IN ('Done', 'Failed')",
        **{**DELIVERIES, "summary": [("Delivered", count_where("q.status = 'Done'"), "num"), ("Failed after retries", count_where("q.status = 'Failed'"), "num"),
                                     ("Success", "ROUND(100 * SUM(q.status = 'Done') / NULLIF(COUNT(*), 0), 1)", "pct")]}),
    Kpi("webhooks.rate_limited", "Rate-limited", "tenants", sql=f"SELECT * FROM ({USAGE_SQL}) uu WHERE uu.rate_limited > 0", sort="rate_limited", **USAGE),
    Kpi("apikeys.api_calls", "API calls · 24 h", "tenants", sql=USAGE_SQL, sort="requests", **USAGE),
    Kpi("apikeys.throttled", "Throttled requests", "tenants", sql=f"SELECT * FROM ({USAGE_SQL}) uu WHERE uu.rate_limited > 0", sort="rate_limited", **USAGE),
    Kpi("apikeys.active", "Active keys", "tenants", sql=f"SELECT * FROM ({KEYS_SQL}) kk WHERE {USABLE}", **KEYS,
        summary=[("Rotate soon", count_where("q.status = 'Rotate soon'"), "num"), ("Never used", count_where("q.last_used_at IS NULL"), "num")]),
    Kpi("apikeys.older_90d", "Keys older than 90 d", "tenants", sql=f"SELECT * FROM ({KEYS_SQL}) kk WHERE {USABLE} AND kk.created_at < UTC_TIMESTAMP() - INTERVAL 90 DAY",
        **{**KEYS, "sort": "age_days"}, summary=[("Oldest (days)", "MAX(q.age_days)", "num"), ("Never used", count_where("q.last_used_at IS NULL"), "num")]),
    Kpi("apikeys.p95", "p95 latency", "tenants", sort="p95", rows=_traffic_24h, columns=[
        Col("at", "Window ending", "datetime"), Col("requests", "Requests", "num"), Col("rps", "Req / s", "num"), Col("p50", "p50", "ms"), Col("p95", "p95", "ms"),
        Col("p99", "p99", "ms"), Col("errors", "Errors", "num"), Col("error_rate", "Error rate", "pct"), Col("minutes_ago", "Minutes ago", "num", hidden=True)],
        tenant=None, tenant_name=None, date="at", link=None,
        note="API response times measured by this server (all tenants), in 24-hour windows of per-minute histograms; only windows with traffic are listed.",
        summary=[("Requests · 24 h", lambda rows: sum(r["requests"] for r in rows), "num"), ("Worst p95", lambda rows: max((r["p95"] for r in rows if r["p95"] is not None), default=None), "ms")]),
)


# ── Mobile app control ───────────────────────────────────────────────────────

DEVICES_SQL = """
SELECT d.id, d.tenant_id, t.name AS tenant, d.user_id, d.user_name, d.model, d.platform, d.os,
       COALESCE(NULLIF(CONCAT_WS(' ', d.platform, d.os), ''), 'Not reported') AS platform_os, COALESCE(d.app_version, 'Not reported') AS app_version,
       COALESCE(d.integrity, 'Not reported') AS integrity, d.last_seen, d.status, d.source, d.created_at
FROM platform_mobile_devices d JOIN tenants t ON t.id = d.tenant_id WHERE t.status <> 'cancelled'
"""
DEVICE_COLS = [Col("user_name", "User"), Col("tenant", "Tenant"), Col("model", "Device"), Col("platform_os", "OS"), Col("app_version", "App version", "code"),
               Col("last_seen", "Last seen", "datetime"), Col("integrity", "Integrity", "pill"), Col("status", "Status", "pill"),
               Col("platform", "Platform", hidden=True), Col("os", "OS version", hidden=True), Col("source", "Registered via", hidden=True),
               Col("created_at", "Registered", "datetime", hidden=True), Col("user_id", "User ID", "num", hidden=True),
               Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Device ID", "num", hidden=True)]
DEVICES = dict(columns=DEVICE_COLS, search=("user_name", "tenant", "model", "app_version", "platform_os"), status="status", date="last_seen", sort="last_seen",
               link="/platform/mobile")


def _on_latest(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_mobile as mob

    live = [r.version for r in db.execute(text("SELECT version FROM platform_mobile_releases WHERE status = 'Live'")).mappings() if mob._ver(r.version)] \
        if False else [v for (v,) in db.execute(text("SELECT version FROM platform_mobile_releases WHERE status = 'Live'")).all() if mob._ver(v)]
    latest = max(live, key=mob._ver, default=None)
    scope = "" if ctx["scope"] is None else f" AND d.tenant_id IN ({','.join(str(int(i)) for i in ctx['scope']) or '0'})"
    out = []
    for r in db.execute(text(DEVICES_SQL.replace("WHERE t.status <> 'cancelled'", f"WHERE t.status <> 'cancelled'{scope}"))).mappings():
        v = mob._ver(r["app_version"])
        out.append({**dict(r), "latest": latest, "on_latest": "Not reported" if not v else "Not comparable" if not latest else "On latest" if v >= mob._ver(latest) else "Behind"})
    return out


PUSHES_SQL = """
SELECT p.id, p.title, p.message, p.audience_label AS audience, p.send_when, p.status, p.targeted, p.accepted, p.failed,
       ROUND(100 * p.accepted / NULLIF(p.targeted, 0)) AS accepted_pct, p.error, p.sent_by, p.created_at, p.scheduled_for, p.sent_at
FROM platform_mobile_pushes p
"""

register(
    Kpi("mobile.registered", "Registered devices", "tenants", sql=DEVICES_SQL, group="app_version", **DEVICES,
        summary=[("Active", count_where("q.status = 'Active'"), "num"), ("Seen · 7 days", count_where("q.last_seen >= UTC_TIMESTAMP() - INTERVAL 7 DAY"), "num")]),
    Kpi("mobile.platforms", "Platform & OS", "tenants", sql=DEVICES_SQL, group="platform_os", **DEVICES),
    Kpi("mobile.active_7d", "Active · 7 days", "tenants",
        sql=f"SELECT * FROM ({DEVICES_SQL}) dd WHERE dd.status = 'Active' AND dd.last_seen >= UTC_TIMESTAMP() - INTERVAL 7 DAY", group="platform_os", **DEVICES),
    Kpi("mobile.crash_free", "Crash-free sessions", "tenants", sql=DEVICES_SQL, group="app_version", **DEVICES,
        note="The app sends no crash reports, so crash-free sessions can't be measured (“—”). Listed: the registered devices."),
    Kpi("mobile.on_latest", "On latest", "tenants", rows=_on_latest, group="on_latest",
        **{**DEVICES, "columns": [*DEVICE_COLS[:5], Col("on_latest", "Latest version", "pill"), Col("latest", "Latest live release", "code"), *DEVICE_COLS[5:]],
           "status": "on_latest"},
        description="Devices reporting an app version at or above the newest Live release; the percentage counts only devices that report a version",
        summary=[("On latest", lambda rows: sum(1 for r in rows if r["on_latest"] == "On latest"), "num"),
                 ("Behind", lambda rows: sum(1 for r in rows if r["on_latest"] == "Behind"), "num"),
                 ("Not reported", lambda rows: sum(1 for r in rows if r["on_latest"] == "Not reported"), "num")]),
    Kpi("mobile.push_24h", "Push delivered · 24h", "tenants", sql=f"SELECT * FROM ({PUSHES_SQL}) pp WHERE pp.status = 'sent' AND pp.sent_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR",
        tenant=None, tenant_name=None, group="audience", link="/platform/mobile",
        columns=[Col("sent_at", "Sent", "datetime"), Col("title", "Title"), Col("audience", "Audience"), Col("targeted", "Targeted", "num"), Col("accepted", "Accepted by FCM", "num"),
                 Col("failed", "Failed", "num"), Col("accepted_pct", "Delivered", "pct"), Col("sent_by", "By"), Col("message", "Message", hidden=True),
                 Col("send_when", "When", hidden=True), Col("status", "Status", "pill", hidden=True), Col("error", "Error", hidden=True),
                 Col("scheduled_for", "Scheduled for", "datetime", hidden=True), Col("created_at", "Created", "datetime", hidden=True), Col("id", "Push ID", "num", hidden=True)],
        search=("title", "message", "audience", "sent_by"), date="sent_at", sort="sent_at",
        summary=[("Accepted", "SUM(q.accepted)", "num"), ("Targeted", "SUM(q.targeted)", "num"),
                 ("Delivery rate", "ROUND(100 * SUM(q.accepted) / NULLIF(SUM(q.targeted), 0))", "pct")]),
    Kpi("mobile.flagged", "Flagged devices", "tenants", sql=f"SELECT * FROM ({DEVICES_SQL}) dd WHERE dd.integrity = 'compromised' OR dd.status <> 'Active'",
        group="status", **DEVICES, summary=[("Jailbroken / rooted", count_where("q.integrity = 'compromised'"), "num"),
                                            ("Locked, wiped or blocked", count_where("q.status <> 'Active'"), "num")]),
)


# ── Marketplace ──────────────────────────────────────────────────────────────

APPS_SQL = """
SELECT a.id, a.name, pb.name AS publisher, pb.contact_email AS publisher_email, a.category, a.price_monthly, a.scopes, a.scope_review, a.scan_result,
       a.scan_findings, a.scanned_at, a.status, a.status_reason, a.status_by, a.status_at, a.created_at, a.private_tenant_id, t.name AS private_tenant,
       (SELECT COUNT(*) FROM platform_market_installs i WHERE i.app_id = a.id AND i.active = 1) AS installs
FROM platform_market_apps a JOIN platform_market_publishers pb ON pb.id = a.publisher_id LEFT JOIN tenants t ON t.id = a.private_tenant_id
"""
APPS = dict(columns=[Col("name", "App"), Col("publisher", "Publisher"), Col("category", "Category"), Col("installs", "Installs", "num"), Col("price_monthly", "Price / month", "inr"),
                     Col("scope_review", "Scope review", "pill"), Col("scan_result", "Code scan", "pill"), Col("status", "Status", "pill"),
                     Col("scopes", "Scopes requested", hidden=True), Col("scan_findings", "Scan findings", "num", hidden=True), Col("scanned_at", "Scanned", "datetime", hidden=True),
                     Col("status_reason", "Status reason", hidden=True), Col("status_by", "Status by", hidden=True), Col("status_at", "Status changed", "datetime", hidden=True),
                     Col("private_tenant", "Private to tenant", hidden=True), Col("publisher_email", "Publisher e-mail", hidden=True),
                     Col("created_at", "Submitted", "datetime", hidden=True), Col("id", "App ID", "num", hidden=True)],
            tenant=None, tenant_name=None, search=("name", "publisher", "category"), date="created_at", sort="created_at", group="category", link="/platform/marketplace")

register(
    Kpi("market.live", "Live apps", "tenants", sql=f"SELECT * FROM ({APPS_SQL}) aa WHERE aa.status = 'Live'", **{**APPS, "sort": "installs"},
        summary=[("Installs", "SUM(q.installs)", "num"), ("Paid apps", count_where("q.price_monthly > 0"), "num")]),
    Kpi("market.in_review", "In review", "tenants", sql=f"SELECT * FROM ({APPS_SQL}) aa WHERE aa.status = 'In review'", **{**APPS, "desc": False},
        summary=[("Scan critical", count_where("q.scan_result = 'critical'"), "num")]),
    Kpi("market.installs", "Installs", "tenants", link=TENANT_LINK, group="app",
        sql="""SELECT i.id, i.app_id, a.name AS app, pb.name AS publisher, a.category, i.tenant_id, t.name AS tenant, i.scopes_granted, i.installed_by_user, i.installed_at
               FROM platform_market_installs i JOIN platform_market_apps a ON a.id = i.app_id JOIN platform_market_publishers pb ON pb.id = a.publisher_id
               JOIN tenants t ON t.id = i.tenant_id WHERE i.active = 1""",
        columns=[Col("app", "App"), Col("publisher", "Publisher"), Col("tenant", "Tenant"), Col("installed_at", "Installed", "datetime"), Col("category", "Category"),
                 Col("scopes_granted", "Scopes granted", hidden=True), Col("installed_by_user", "Installed by user", "num", hidden=True),
                 Col("app_id", "App ID", "num", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Install ID", "num", hidden=True)],
        search=("app", "publisher", "tenant"), date="installed_at", sort="installed_at"),
    Kpi("market.suspended", "Suspended", "tenants", sql=f"SELECT * FROM ({APPS_SQL}) aa WHERE aa.status = 'Suspended'", **{**APPS, "sort": "status_at"}),
    Kpi("market.revenue_share", "Revenue share · 30d", "tenants", sql=f"SELECT * FROM ({APPS_SQL}) aa WHERE aa.price_monthly > 0", **{**APPS, "sort": "installs"},
        note="Paid-app billing isn't built yet, so no revenue share is collected (“—”). Listed: the paid apps and their active installs.",
        summary=[("List value / month", "SUM(q.price_monthly * q.installs)", "inr")]),
)
