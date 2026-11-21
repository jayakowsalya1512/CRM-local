"""Monitoring module: KPIs, charts, status page, alert rules and incidents.

Paths sit under ``/monitoring`` so the Monitoring permission of the caller's platform role applies (view to read,
manage to create or switch alert rules).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_monitoring import PlatformAlertRule, PlatformIncident
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_controls as controls
from app.services import platform_infrastructure as infrastructure
from app.services import platform_monitoring as monitor
from app.services import platform_uptime
from app.services.platform_access import enforce_platform_access

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/platform/monitoring", dependencies=[Depends(enforce_platform_access)])

IN_API_PROCESS = "Runs inside the API process"
WEB_NOTE = "The web app is served as static files outside the API, so its requests are not measured here"


def _rule_payload(rule: PlatformAlertRule) -> dict:
    detail = rule.last_detail or {}
    target = rule.target
    if rule.action == "slack" and target:
        target = urlparse(target).netloc or "webhook"  # never echo the secret webhook path
    return {
        "id": rule.id, "label": monitor.rule_label(rule), "metric": rule.metric, "threshold": rule.threshold,
        "duration_minutes": rule.duration_minutes, "action": rule.action, "action_label": monitor.ACTIONS.get(rule.action, rule.action),
        "target": target, "severity": rule.severity, "enabled": rule.enabled, "state": rule.state if rule.enabled else "disabled",
        "last_value": rule.last_value, "last_evaluated_at": rule.last_evaluated_at.isoformat() + "Z" if rule.last_evaluated_at else None,
        "last_fired_at": rule.last_fired_at.isoformat() + "Z" if rule.last_fired_at else None,
        "reason": detail.get("reason"), "delivery": detail.get("delivery"),
    }


def _incident_payload(incident: PlatformIncident) -> dict:
    return {"id": incident.id, "code": f"INC-{incident.id:03d}", "title": incident.title, "severity": incident.severity, "status": incident.status,
            "started_at": incident.started_at.isoformat() + "Z", "resolved_at": incident.resolved_at.isoformat() + "Z" if incident.resolved_at else None,
            "source": incident.source}


def _availability(service: str, slo: float) -> dict:
    inventory = infrastructure.server_inventory()
    if service == "database":
        names = [s["name"] for s in inventory if s.get("db_host")]
    elif service == "all":
        names = [s["name"] for s in inventory]
    else:
        names = [s["name"] for s in inventory if s.get("local") or s.get("agent_url")]
    uptime = platform_uptime.uptime(names)
    values = [v for v in uptime["servers"].values() if v is not None]
    tracked = uptime.get("tracked_minutes") or 0
    if not values or not tracked:
        return {"availability": None, "tracked_minutes": tracked, "error_budget_left": None, "reason": uptime.get("error") or "Uptime tracking has not started yet"}
    availability = round(sum(values) / len(values), 2)
    allowed = (100 - slo) / 100 * tracked
    downtime = (100 - availability) / 100 * tracked
    left = max(0.0, (1 - downtime / allowed) * 100) if allowed > 0 else None
    return {"availability": availability, "tracked_minutes": tracked, "error_budget_left": round(left, 1) if left is not None else None, "reason": None}


def _saturation(service: str, minutes: int) -> dict:
    role = "Database" if service == "database" else None if service == "all" else "Application"
    by_server = monitor.cpu_by_server(minutes, role)
    if by_server:
        server, cpu = max(by_server.items(), key=lambda item: item[1])
        return {"value": cpu, "server": server, "source": "samples"}
    # No probe samples yet (the uptime loop records them each minute): fall back to this server, if it plays the role.
    local_entry = next((s for s in infrastructure.server_inventory() if s.get("local")), None)
    local = infrastructure.local_node_metrics()
    if local.get("available") and local_entry and (role != "Database" or local_entry.get("db_host")):
        return {"value": local["cpu_percent"], "server": local.get("hostname"), "source": "live"}
    return {"value": None, "server": None, "source": None}


def _usage(range_minutes: int) -> list[dict]:
    procs = monitor.process_usage() or {}
    api, celery, database = procs.get("api"), procs.get("celery"), procs.get("database")
    if database is None:
        db_host = next((s for s in infrastructure.server_inventory() if s.get("db_host")), None)
        sample = monitor.latest_server_sample(db_host["name"]) if db_host else None
        if sample and sample.cpu is not None:
            database = {"cpu": round(sample.cpu, 1), "memory": round(sample.memory or 0, 1), "host": True}
    row = lambda label, usage, note=None: {"label": label, "cpu": usage["cpu"] if usage else None, "memory": usage["memory"] if usage else None, "note": note}
    return [
        row("API gateway", api, f"{api['processes']} API process(es)" if api else "psutil unavailable"),
        row("Workflow engine", api, IN_API_PROCESS),
        row("Notification", celery, f"{celery['processes']} Celery worker process(es)" if celery else "No Celery worker running on this server"),
        row("Doc store", api, IN_API_PROCESS),
        row("AI service", api, IN_API_PROCESS),
        row("Database", database, "Database host (no local database process)" if database and database.get("host") else "MariaDB process" if database else "Database runs on another server without a metrics agent"),
    ]


@router.get("")
def monitoring_overview(service: str = Query("All services"), range: str = Query("1h"), db: Session = Depends(get_master_db_dep)):
    if service not in monitor.SERVICES:
        raise HTTPException(status_code=400, detail="Unknown service")
    if range not in monitor.RANGES:
        raise HTTPException(status_code=400, detail="Range must be 1h, 6h, 24h or 7d")
    key = monitor.SERVICES[service]
    minutes = monitor.RANGES[range]
    slo = float(controls.value(db, "sloAvail") or 99.9)
    apdex_target = float(controls.value(db, "sloLat") or 300)
    error_limit = float(controls.value(db, "alertErr") or 1)

    metric_service = None if key == "web" else "api" if key == "all" else key
    stats = monitor.window_stats(metric_service, minutes) if metric_service else None
    availability = _availability(key, slo)
    saturation = _saturation(key, minutes)
    monitor.seed_rules(db)
    return {
        "service": service, "range": range, "generated_at": datetime.utcnow().isoformat() + "Z",
        "request_metrics": metric_service is not None, "request_metrics_note": None if metric_service else WEB_NOTE,
        "unit": "queries" if key == "database" else "requests",
        "kpis": {
            "availability_30d": availability["availability"], "availability_tracked_minutes": availability["tracked_minutes"],
            "availability_reason": availability["reason"], "slo_percent": slo,
            "p95_ms": stats["p95"] if stats else None, "requests": stats["requests"] if stats else None,
            "error_rate": stats["error_rate"] if stats else None,
            "error_budget_left": availability["error_budget_left"],
            "apdex": monitor.apdex(stats["hist"], apdex_target) if stats else None, "apdex_target_ms": apdex_target,
            "saturation": saturation["value"], "saturation_server": saturation["server"], "saturation_source": saturation["source"],
        },
        "series": monitor.series(metric_service, range) if metric_service else [],
        "collecting_since": (lambda m: m * 60 if m is not None else None)(monitor.first_minute(metric_service)) if metric_service else None,
        "usage": _usage(minutes),
        "status": monitor.status_page(error_limit),
        "rules": [_rule_payload(r) for r in db.query(PlatformAlertRule).order_by(PlatformAlertRule.id).all()],
        "incidents": [_incident_payload(i) for i in db.query(PlatformIncident).order_by(PlatformIncident.started_at.desc()).limit(50).all()],
        "rule_options": {"metrics": {k: {"label": v[0], "unit": v[1], "window": v[2]} for k, v in monitor.METRICS.items()}, "actions": monitor.ACTIONS},
    }


def _audit(db: Session, request: Request, action: str, rule: PlatformAlertRule, description: str) -> None:
    _write_platform_audit(db, _get_platform_admin(request), action, "alert_rule", rule.id, monitor.rule_label(rule), description,
                          get_request_ip(request), new_data=_rule_payload(rule))


class RuleCreate(BaseModel):
    metric: str
    threshold: float = Field(gt=0)
    duration_minutes: int = Field(default=5, ge=1, le=1440)
    action: str
    target: Optional[str] = Field(default=None, max_length=500)
    severity: str = "SEV3"
    enabled: bool = True


@router.post("/alert-rules")
def create_alert_rule(data: RuleCreate, request: Request, db: Session = Depends(get_master_db_dep)):
    if data.metric not in monitor.METRICS:
        raise HTTPException(status_code=400, detail="Unknown metric")
    if data.action not in monitor.ACTIONS:
        raise HTTPException(status_code=400, detail="Unknown action")
    if data.severity not in ("SEV1", "SEV2", "SEV3"):
        raise HTTPException(status_code=400, detail="Severity must be SEV1, SEV2 or SEV3")
    if data.action == "email_tenant_admin" and data.metric != "tenant_storage":
        raise HTTPException(status_code=400, detail="Email tenant admin is only available for tenant storage alerts")
    target = (data.target or "").strip() or None
    if data.action == "slack" and (not target or urlparse(target).scheme != "https"):
        raise HTTPException(status_code=400, detail="Enter the Slack incoming-webhook URL (https://hooks.slack.com/…)")
    if data.action == "email" and not target:
        raise HTTPException(status_code=400, detail="Enter at least one e-mail address")
    if data.metric == "error_rate" and data.threshold > 100 or data.metric == "tenant_storage" and data.threshold > 100:
        raise HTTPException(status_code=400, detail="Percent thresholds must be 100 or less")
    admin = _get_platform_admin(request)
    rule = PlatformAlertRule(metric=data.metric, threshold=data.threshold, enabled=data.enabled, action=data.action, target=target, severity=data.severity,
                             duration_minutes=data.duration_minutes if data.metric in monitor._WINDOWED else 1,
                             created_by=(admin.email if admin else None))
    db.add(rule)
    db.flush()
    if rule.enabled:
        try:
            monitor.evaluate_rule(db, rule)
        except Exception:
            logger.exception("Initial evaluation of alert rule %s failed", rule.id)
    _audit(db, request, "monitoring.alert_rule_create", rule, f"Alert rule created: {monitor.rule_label(rule)} → {monitor.ACTIONS[rule.action]}")
    db.commit()
    return _rule_payload(rule)


class RuleToggle(BaseModel):
    enabled: bool


@router.patch("/alert-rules/{rule_id}")
def toggle_alert_rule(rule_id: int, data: RuleToggle, request: Request, db: Session = Depends(get_master_db_dep)):
    monitor.ensure_schema()
    rule = db.get(PlatformAlertRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Alert rule not found")
    rule.enabled = data.enabled
    if data.enabled:
        try:
            monitor.evaluate_rule(db, rule)
        except Exception:
            logger.exception("Evaluation of alert rule %s failed", rule.id)
    else:
        rule.state = "pending"
        monitor._resolve_incidents(db, f"rule:{rule.id}")
    _audit(db, request, "monitoring.alert_rule_toggle", rule, f"Alert rule {'enabled' if data.enabled else 'disabled'}: {monitor.rule_label(rule)}")
    db.commit()
    return _rule_payload(rule)
